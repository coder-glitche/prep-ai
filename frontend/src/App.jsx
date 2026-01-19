import { useEffect, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const ANSWER_RECORD_MS = 45000;

const TURN = {
  ASKING: "ASKING",
  LISTENING: "LISTENING",
  SUBMITTING: "SUBMITTING",
  FEEDBACK: "FEEDBACK",
  DONE: "DONE",
};

function App() {
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState("");

  const [resumeText, setResumeText] = useState("");
  const [topicsText, setTopicsText] = useState("");

  const [resumeFile, setResumeFile] = useState(null);
  const [isSummarizingResume, setIsSummarizingResume] = useState(false);

  const [kbResume, setKbResume] = useState("");
  const [kbTopics, setKbTopics] = useState("");

  const [questions, setQuestions] = useState([]);
  const [editingQuestions, setEditingQuestions] = useState([]);
  const [interviewStarted, setInterviewStarted] = useState(false);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [allQA, setAllQA] = useState([]);

  const [agentMessage, setAgentMessage] = useState("Create an interview to get started.");
  const [userInput, setUserInput] = useState("");

  const [scores, setScores] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const [turnState, setTurnState] = useState(TURN.DONE);

  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const activeSubmitTokenRef = useRef(0);

  // ---------- helpers ----------
  const speak = (text, onEnd) => {
    if (!window.speechSynthesis) {
      onEnd && onEnd();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => onEnd && onEnd();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  const stopAnyRecording = () => {
    try {
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    axios.get(`${API_BASE}/api/roles`).then((res) => setRoles(res.data.roles));
  }, []);

  // ---------- recording ----------
  const startRecording = async () => {
    if (turnState !== TURN.LISTENING) return;
    if (isRecording) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Your browser does not support audio recording.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      setRecordSeconds(0);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        clearInterval(recordTimerRef.current);
        setRecordSeconds(0);

        const blob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);

        // Only process if still LISTENING (prevents stale submits)
        if (turnState !== TURN.LISTENING) return;

        await submitVoiceBlob(blob);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);

      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);

      setTimeout(() => {
        if (mediaRecorder.state === "recording") mediaRecorder.stop();
      }, ANSWER_RECORD_MS);
    } catch (err) {
      console.error("Error accessing mic:", err);
      alert("Could not access microphone.");
    }
  };

  const stopRecording = () => {
    if (turnState !== TURN.LISTENING) return;
    if (mediaRecorderRef.current && isRecording) mediaRecorderRef.current.stop();
  };

  // ---------- voice submission ----------
  const submitVoiceBlob = async (blob) => {
    if (turnState !== TURN.LISTENING) return;

    setTurnState(TURN.SUBMITTING);
    activeSubmitTokenRef.current += 1;
    const token = activeSubmitTokenRef.current;

    const formData = new FormData();
    formData.append("file", blob, "answer.webm");

    try {
      const transcribeRes = await axios.post(`${API_BASE}/api/transcribe`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (activeSubmitTokenRef.current !== token) return;

      const transcript = (transcribeRes.data.text || "").trim();
      if (!transcript) {
        setAgentMessage("I couldn’t catch that. Please answer again (voice or text).");
        speak("I couldn’t catch that. Please answer again, voice or text.", () => {
          setTurnState(TURN.LISTENING);
        });
        return;
      }

      await submitSingleAnswer(transcript, { source: "voice" }, token);
    } catch (e) {
      console.error("Transcription error:", e);
      if (activeSubmitTokenRef.current !== token) return;

      setAgentMessage("Transcription failed. Please type your answer.");
      speak("Transcription failed. Please type your answer.");
      setTurnState(TURN.LISTENING);
    }
  };

  // ---------- typed submission ----------
  const handleTextSubmit = async (e) => {
    e.preventDefault();
    if (turnState !== TURN.LISTENING) return;

    stopAnyRecording();

    const trimmed = (userInput || "").trim();
    if (!trimmed) return;

    setTurnState(TURN.SUBMITTING);
    activeSubmitTokenRef.current += 1;
    const token = activeSubmitTokenRef.current;

    await submitSingleAnswer(trimmed, { source: "typed" }, token);
  };

  // ---------- single answer => backend respond => feedback => next question ----------
  const submitSingleAnswer = async (answerText, meta, token) => {
    const question = questions[currentIndex];
    if (!question) {
      setTurnState(TURN.LISTENING);
      return;
    }

    try {
      const res = await axios.post(`${API_BASE}/api/respond`, {
        role: selectedRole,
        question,
        candidate_answer: answerText,
      });

      if (activeSubmitTokenRef.current !== token) return;

      const { reply, summary, remarks, score } = res.data;

      const qaItem = {
        question: question.text,
        conversation: [
          { sender: "agent", text: `Question: ${question.text}` },
          { sender: "candidate", text: answerText },
          { sender: "agent", text: reply },
        ],
        summary,
        remarks,
        score,
        meta,
      };

      const updatedAllQA = [...allQA, qaItem];
      setAllQA(updatedAllQA);

      // FEEDBACK lock: no more input until next question
      setTurnState(TURN.FEEDBACK);
      setAgentMessage(reply);
      setUserInput("");

      speak(reply, () => {
        const next = currentIndex + 1;
        if (next < questions.length) {
          askQuestion(next);
        } else {
          finishInterview(updatedAllQA);
        }
      });
    } catch (e) {
      console.error("Respond error:", e);
      if (activeSubmitTokenRef.current !== token) return;

      setAgentMessage("Backend error. Please try again.");
      speak("Backend error. Please try again.");
      setTurnState(TURN.LISTENING);
    }
  };

  // ---------- skip: immediate ----------
  const handleSkipClick = async () => {
    if (turnState !== TURN.LISTENING) return;

    stopAnyRecording();
    setTurnState(TURN.SUBMITTING);
    activeSubmitTokenRef.current += 1;
    const token = activeSubmitTokenRef.current;

    const question = questions[currentIndex];
    if (!question) {
      setTurnState(TURN.LISTENING);
      return;
    }

    try {
      const res = await axios.post(`${API_BASE}/api/skip`, {
        role: selectedRole,
        question,
      });

      if (activeSubmitTokenRef.current !== token) return;

      const { reply, summary, remarks, score } = res.data;

      const qaItem = {
        question: question.text,
        conversation: [
          { sender: "agent", text: `Question: ${question.text}` },
          { sender: "candidate", text: "[SKIPPED]" },
          { sender: "agent", text: reply },
        ],
        summary,
        remarks,
        score,
        meta: { source: "skip" },
      };

      const updatedAllQA = [...allQA, qaItem];
      setAllQA(updatedAllQA);

      setTurnState(TURN.FEEDBACK);
      setAgentMessage(reply);
      setUserInput("");

      speak(reply, () => {
        const next = currentIndex + 1;
        if (next < questions.length) {
          askQuestion(next);
        } else {
          finishInterview(updatedAllQA);
        }
      });
    } catch (e) {
      console.error("Skip error:", e);
      if (activeSubmitTokenRef.current !== token) return;

      setAgentMessage("Skip failed. Please try again.");
      speak("Skip failed. Please try again.");
      setTurnState(TURN.LISTENING);
    }
  };

  // ---------- question generation ----------
  const generateQuestions = async () => {
    if (!selectedRole) {
      alert("Please select a role.");
      return;
    }

    const res = await axios.post(`${API_BASE}/api/generate-questions`, {
      role: selectedRole,
      resume_summary: resumeText,
      topics: topicsText,
    });

    setQuestions(res.data.questions);
    setEditingQuestions(res.data.questions.map((q) => ({ ...q })));

    setInterviewStarted(false);
    setScores(null);
    setFeedback(null);
    setAllQA([]);

    setKbResume(resumeText);
    setKbTopics(topicsText);

    setAgentMessage("Review and tweak the questions, then start the interview.");
    setTurnState(TURN.DONE);
  };

  const startInterview = () => {
    if (editingQuestions.length !== 3) {
      alert("You must have exactly 3 questions.");
      return;
    }
    setQuestions(editingQuestions);
    setInterviewStarted(true);
    setScores(null);
    setFeedback(null);
    setAllQA([]);
    askQuestion(0);
  };

  const askQuestion = (index) => {
    // invalidate any in-flight submits
    activeSubmitTokenRef.current += 1;

    setCurrentIndex(index);
    const q = editingQuestions[index];
    if (!q) return;

    const msg = `Question ${index + 1} of 3: ${q.text}`;
    setAgentMessage(msg);
    setUserInput("");

    setTurnState(TURN.ASKING);
    speak(msg, () => {
      // Now LISTENING: user can type OR start recording manually
      setTurnState(TURN.LISTENING);
    });
  };

  // ---------- evaluation ----------
  const finishInterview = async (qaData) => {
    try {
      const evalRes = await axios.post(`${API_BASE}/api/evaluate`, {
        role: selectedRole,
        qa: qaData,
      });
      setScores(evalRes.data.scores);
      setFeedback(evalRes.data.feedback);

      await axios.post(`${API_BASE}/api/save-result`, {
        role: selectedRole,
        resume_summary: kbResume,
        topics: kbTopics,
        qa: qaData,
        scores: evalRes.data.scores,
        feedback: evalRes.data.feedback,
      });

      setAgentMessage("Interview completed. Review your scores and feedback.");
      speak("Thanks for completing the mock interview. I have generated your scores and feedback.");

      setInterviewStarted(false);
      setTurnState(TURN.DONE);
    } catch (err) {
      console.error("finishInterview error:", err);
      setAgentMessage("Interview completed, but evaluation failed.");
      speak("Interview completed, but evaluation failed.");
      setInterviewStarted(false);
      setTurnState(TURN.DONE);
    }
  };

  // ---------- resume upload ----------
  const handleResumeUpload = async () => {
    if (!resumeFile) {
      alert("Please choose a PDF resume first.");
      return;
    }
    if (!selectedRole) {
      alert("Select role before summarizing resume.");
      return;
    }

    const formData = new FormData();
    formData.append("file", resumeFile);
    formData.append("role", selectedRole);

    setIsSummarizingResume(true);
    try {
      const res = await axios.post(`${API_BASE}/api/resume-summary`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResumeText(res.data.summary);
    } catch (e) {
      console.error("Resume summary error:", e);
      alert("Failed to summarize resume.");
    } finally {
      setIsSummarizingResume(false);
    }
  };

  const formatSeconds = (s) => {
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const currentRoleName = roles.find((r) => r.id === selectedRole)?.name || "No role selected";

  const canInteract = turnState === TURN.LISTENING;
  const canSkip = canInteract && !isRecording;
  const canTypeSend = canInteract && !isRecording;
  const canStartRecord = canInteract && !isRecording;
  const canStopSend = canInteract && isRecording;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-dot" />
          <span className="logo-text">Prep.AI</span>
          <span className="logo-beta">beta</span>
        </div>

        <nav className="sidebar-nav">
          <button className="nav-item nav-item-active">
            <span className="nav-icon">🎙️</span>
            <span>Interviews</span>
          </button>
          <button className="nav-item" disabled>
            <span className="nav-icon">👥</span>
            <span>Interviewers</span>
          </button>
          <button className="nav-item" disabled>
            <span className="nav-icon">⚙️</span>
            <span>Settings</span>
          </button>
          <button className="nav-item" disabled>
            <span className="nav-icon">💳</span>
            <span>Billing</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="user-avatar">Y</div>
          <div className="user-meta">
            <div className="user-name">Yogesh</div>
            <div className="user-role">Creator</div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-breadcrumb">Dashboard /</span>
            <span className="topbar-heading"> Interview Practice Agent</span>
          </div>
          <div className="topbar-right">
            <span className="role-pill">{currentRoleName}</span>
          </div>
        </header>

        <div className="content-grid">
          <section className="column-left">
            {!interviewStarted && !scores && (
              <div className="card card-config">
                <div className="card-header">
                  <h2>Create an Interview</h2>
                  <p className="card-subtitle">
                    Define the role, give a resume + topics, and auto-generate 3 questions.
                  </p>
                </div>

                <div className="config-grid">
                  <div className="config-group">
                    <label className="field-label">Role</label>
                    <select
                      className="field-input"
                      value={selectedRole}
                      onChange={(e) => setSelectedRole(e.target.value)}
                    >
                      <option value="">Choose a role…</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="config-group">
                    <label className="field-label">Upload Resume (PDF)</label>
                    <div className="resume-upload">
                      <input
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => setResumeFile(e.target.files?.[0] || null)}
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleResumeUpload}
                        disabled={!resumeFile || isSummarizingResume}
                      >
                        {isSummarizingResume ? "Summarizing…" : "Extract & Summarize"}
                      </button>
                    </div>
                    <p className="hint-text">
                      We’ll use this summary to craft a project-based question.
                    </p>
                  </div>

                  <div className="config-group">
                    <label className="field-label">Resume Summary</label>
                    <textarea
                      className="field-input field-textarea"
                      placeholder="Paste or edit a short summary of the candidate's experience and projects."
                      value={resumeText}
                      onChange={(e) => setResumeText(e.target.value)}
                    />
                  </div>

                  <div className="config-group">
                    <label className="field-label">Technical Topics</label>
                    <textarea
                      className="field-input field-textarea"
                      placeholder="e.g. Arrays, DP, REST APIs, system design basics..."
                      value={topicsText}
                      onChange={(e) => setTopicsText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="config-actions">
                  <button className="btn-primary" onClick={generateQuestions}>
                    Generate 3 Questions
                  </button>
                </div>
              </div>
            )}

            {editingQuestions.length > 0 && !interviewStarted && !scores && (
              <div className="card card-questions">
                <div className="card-header">
                  <h2>Question Set</h2>
                  <p className="card-subtitle">You can edit the questions before starting.</p>
                </div>

                <div className="question-list">
                  {editingQuestions.map((q, idx) => (
                    <div key={q.id} className="question-item">
                      <div className="question-header">
                        <span className="question-label">Question {idx + 1}</span>
                        <span className={`type-pill type-${q.type}`}>{q.type}</span>
                      </div>
                      <textarea
                        className="field-input field-textarea"
                        value={q.text}
                        onChange={(e) => {
                          const clone = [...editingQuestions];
                          clone[idx] = { ...clone[idx], text: e.target.value };
                          setEditingQuestions(clone);
                        }}
                      />
                    </div>
                  ))}
                </div>

                <div className="config-actions">
                  <button className="btn-primary" onClick={startInterview}>
                    Start Interview
                  </button>
                </div>
              </div>
            )}

            {interviewStarted && (
              <div className="card card-interview">
                <div className="interview-header">
                  <div>
                    <h2 className="interview-title">Mock {currentRoleName} Interview</h2>
                    <p className="interview-subtitle">
                      One answer per question. One feedback. Then next question.
                    </p>
                  </div>
                  <div className="interview-progress">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${((currentIndex + 1) / 3) * 100}%` }}
                      />
                    </div>
                    <span className="progress-text">Question {currentIndex + 1} of 3</span>
                  </div>
                </div>

                <div className="interview-body">
                  <div className="interview-panel interviewer-panel">
                    <div className="avatar-circle avatar-agent">L</div>
                    <div className="panel-label">Interviewer</div>
                    <div className="question-text">{agentMessage}</div>
                  </div>

                  <div className="interview-panel candidate-panel">
                    <div className="avatar-circle avatar-you">You</div>
                    <div className="panel-label">You</div>
                    <p className="candidate-hint">
                      Answer by typing, or click <strong>Start Recording</strong> and then <strong>Stop &amp; Send</strong>.
                    </p>

                    <form onSubmit={handleTextSubmit}>
                      <textarea
                        className="field-input field-textarea"
                        placeholder="Type your answer here (one submission per question)."
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                        disabled={!canTypeSend}
                      />
                      <button type="submit" className="btn-secondary" disabled={!canTypeSend}>
                        Send Typed Answer
                      </button>
                    </form>
                  </div>
                </div>

                <div className="interview-footer">
                  <div className="record-widget">
                    <div className={`record-dot ${isRecording ? "record-dot-on" : ""}`} />
                    <span className="record-time">
                      {isRecording ? "Recording" : turnState} • {formatSeconds(recordSeconds)}
                    </span>

                    <button className="btn-record" onClick={startRecording} disabled={!canStartRecord}>
                      ⏺ Start Recording
                    </button>
                    <button className="btn-record" onClick={stopRecording} disabled={!canStopSend}>
                      ⏹ Stop &amp; Send
                    </button>
                  </div>

                  <div className="footer-actions">
                    <button className="btn-secondary" type="button" onClick={handleSkipClick} disabled={!canSkip}>
                      Skip
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="column-right">
            <div className="card card-summary">
              <div className="card-header">
                <h2>Session Overview</h2>
                <p className="card-subtitle">Final scores and feedback after completion.</p>
              </div>

              {!scores && (
                <div className="empty-state">
                  <p>Complete the 3 questions to generate a consolidated evaluation.</p>
                </div>
              )}

              {scores && feedback && (
                <>
                  <div className="score-grid">
                    <div className="score-card">
                      <div className="score-ring">
                        <div className="score-ring-inner">{Math.round(scores.overall)}</div>
                      </div>
                      <div className="score-label">Overall Hiring Score</div>
                      <p className="score-text">{feedback.summary}</p>
                    </div>

                    <div className="score-card">
                      <div className="score-ring small-ring">
                        <div className="score-ring-inner">{scores.communication.toFixed(1)}</div>
                      </div>
                      <div className="score-label">Communication</div>
                      <p className="score-text">{feedback.strengths?.[0] || "—"}</p>
                    </div>

                    <div className="score-card">
                      <div className="score-ring small-ring">
                        <div className="score-ring-inner">{scores.technical.toFixed(1)}</div>
                      </div>
                      <div className="score-label">Technical Depth</div>
                      <p className="score-text">{feedback.improvements?.[0] || "—"}</p>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div className="detail-card">
                      <h3>Strengths</h3>
                      <ul>
                        {(feedback.strengths || []).map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="detail-card">
                      <h3>Areas to Improve</h3>
                      <ul>
                        {(feedback.improvements || []).map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="detail-card">
                      <h3>Next Steps</h3>
                      <p>{feedback.nextSteps}</p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;

