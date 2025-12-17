import { useEffect, useRef, useState } from "react";
import axios from "axios";
import "./App.css";
// at top of App.jsx
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

const MAX_FOLLOWUPS_PER_QUESTION = 1;
const MAX_QUESTION_MINUTES = 10;
const ANSWER_RECORD_MS = 45000; // 45s per answer window

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
  const [currentConversation, setCurrentConversation] = useState([]);
  const [allQA, setAllQA] = useState([]);

  const [agentMessage, setAgentMessage] = useState(
    "Create an interview to get started."
  );
  const [userInput, setUserInput] = useState("");

  const [scores, setScores] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const [questionStartTime, setQuestionStartTime] = useState(null);
  const [followupCount, setFollowupCount] = useState(0);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const [showTranscript, setShowTranscript] = useState(false);

  const [skipStage, setSkipStage] = useState(0); // 0 = not skipped, 1 = hint already given

  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordTimerRef = useRef(null);

  // ---------- helpers ----------
  const speak = (text, onEnd) => {
    if (!window.speechSynthesis) {
      if (onEnd) onEnd();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => {
      if (onEnd) onEnd();
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  const resetQuestionState = () => {
    // wipe "memory" for the next question
    setCurrentConversation([]);
    setFollowupCount(0);
    setQuestionStartTime(null);
    setSkipStage(0);
    setUserInput("");
  };

  useEffect(() => {
    axios.get(`${API_BASE}/api/roles`).then((res) => {
      setRoles(res.data.roles);
    });
  }, []);

  // ---------- recording ----------
  const startRecording = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Your browser does not support audio recording.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      setRecordSeconds(0);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        clearInterval(recordTimerRef.current);
        setRecordSeconds(0);
        const blob = new Blob(recordedChunksRef.current, {
          type: "audio/webm",
        });
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        await handleVoiceBlob(blob);
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);

      recordTimerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );

      setTimeout(() => {
        if (mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, ANSWER_RECORD_MS);
    } catch (err) {
      console.error("Error accessing mic:", err);
      alert("Could not access microphone.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  const handleVoiceBlob = async (blob) => {
    const formData = new FormData();
    formData.append("file", blob, "answer.webm");

    try {
      const transcribeRes = await axios.post(
        `${API_BASE}/api/transcribe`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );

      const transcript = (transcribeRes.data.text || "").trim();
      if (!transcript) {
        alert("I couldn’t understand the audio. Try again or type your answer.");
        return;
      }
      await handleUserAnswer(transcript);
    } catch (e) {
      console.error("Transcription error:", e);
      alert("Transcription failed. Please type your answer.");
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
    resetQuestionState();

    setKbResume(resumeText);
    setKbTopics(topicsText);
    setAgentMessage("Review and tweak the questions, then start the interview.");
  };

  // ---------- start / ask question ----------
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
    const q = editingQuestions[index];
    if (!q) return;

    resetQuestionState(); // clear any previous conversation/followups

    setCurrentIndex(index);
    const msg = `Question ${index + 1} of 3: ${q.text}`;
    setAgentMessage(msg);
    const newConv = [{ sender: "agent", text: msg }];
    setCurrentConversation(newConv);
    setQuestionStartTime(Date.now());

    speak(msg, () => {
      startRecording();
    });
  };

  // ---------- candidate answer ----------
  const handleUserAnswer = async (textFromUser) => {
    const trimmed = (textFromUser || "").trim();
    if (!trimmed) return;

    const question = questions[currentIndex];
    if (!question) return;

    const baseConv = [
      ...currentConversation,
      { sender: "candidate", text: trimmed },
    ];
    setCurrentConversation(baseConv);

    const elapsedMinutes =
      questionStartTime != null
        ? (Date.now() - questionStartTime) / (1000 * 60)
        : 0;

    const res = await axios.post(`${API_BASE}/api/answer`, {
      role: selectedRole,
      question,
      conversation: baseConv,
      followup_count: followupCount,
      elapsed_minutes: elapsedMinutes,
    });

    const { reply, done } = res.data;

    const convWithAgent = [...baseConv, { sender: "agent", text: reply }];
    setCurrentConversation(convWithAgent);
    setAgentMessage(reply);

    const newFollowupCount = followupCount + 1;
    setFollowupCount(newFollowupCount);

    const forcedDone =
      done ||
      elapsedMinutes >= MAX_QUESTION_MINUTES ||
      newFollowupCount >= MAX_FOLLOWUPS_PER_QUESTION;

    // Build QA snapshot for THIS question only
    const qaBase = {
      question: question.text,
      conversation: convWithAgent,
    };

    if (forcedDone) {
      // Summarize + score this single question, then wipe memory
      let qaWithSummary = qaBase;
      try {
        const sumRes = await axios.post(`${API_BASE}/api/summarize-answer`, {
          role: selectedRole,
          question: question.text,
          conversation: convWithAgent,
        });
        qaWithSummary = {
          ...qaBase,
          summary: sumRes.data.summary,
          remarks: sumRes.data.remarks,
          score: sumRes.data.score,
        };
      } catch (e) {
        console.error("Summarize error:", e);
      }

      const updatedAllQA = [...allQA, qaWithSummary];
      setAllQA(updatedAllQA);

      // hard-reset per-question state BEFORE going to next one
      resetQuestionState();

      speak(reply, () => {
        if (currentIndex + 1 < questions.length) {
          askQuestion(currentIndex + 1);
        } else {
          finishInterview(updatedAllQA);
        }
      });
    } else {
      speak(reply, () => {
        startRecording();
      });
    }

    setUserInput("");
  };

  const handleTextSubmit = (e) => {
    e.preventDefault();
    handleUserAnswer(userInput);
  };

  // ---------- skip flow ----------
  const handleSkipClick = async () => {
    stopRecording();

    const question = questions[currentIndex];
    if (!question) return;

    try {
      const res = await axios.post(`${API_BASE}/api/skip-question`, {
        role: selectedRole,
        question,
        conversation: currentConversation,
        attempt: skipStage,
      });

      const { reply, done } = res.data;
      const convWithAgent = [
        ...currentConversation,
        { sender: "agent", text: reply },
      ];
      setCurrentConversation(convWithAgent);
      setAgentMessage(reply);

      if (!done) {
        // first skip: hint, same question continues
        setSkipStage(1);
        speak(reply, () => {
          startRecording();
        });
      } else {
        // confirmed skip: treat as completed question (with low score)
        const qaBase = {
          question: question.text,
          conversation: convWithAgent,
        };
        let qaWithSummary = qaBase;
        try {
          const sumRes = await axios.post(`${API_BASE}/api/summarize-answer`, {
            role: selectedRole,
            question: question.text,
            conversation: convWithAgent,
          });
          qaWithSummary = {
            ...qaBase,
            summary: sumRes.data.summary,
            remarks: sumRes.data.remarks,
            score: sumRes.data.score,
          };
        } catch (e) {
          console.error("Summarize error (skip):", e);
        }

        const updatedAllQA = [...allQA, qaWithSummary];
        setAllQA(updatedAllQA);

        // wipe memory for next question
        resetQuestionState();

        speak(reply, () => {
          if (currentIndex + 1 < questions.length) {
            askQuestion(currentIndex + 1);
          } else {
            finishInterview(updatedAllQA);
          }
        });
      }
    } catch (e) {
      console.error("Skip error:", e);
    }
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

      setAgentMessage(
        "Interview completed. Review your scores and feedback on the right."
      );
      speak(
        "Thanks for completing the mock interview. I have generated your scores and feedback."
      );
      setInterviewStarted(false);
      resetQuestionState();
    } catch (err) {
      console.error("Error in finishInterview:", err);
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

  const currentRoleName =
    roles.find((r) => r.id === selectedRole)?.name || "No role selected";

  return (
    <div className="app-shell">
      {/* Sidebar */}
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

      {/* Main content */}
      <main className="main">
        {/* Top bar */}
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
          {/* Left column */}
          <section className="column-left">
            {!interviewStarted && !scores && (
              <div className="card card-config">
                <div className="card-header">
                  <h2>Create an Interview</h2>
                  <p className="card-subtitle">
                    Define the role, give a resume + topics, and auto-generate
                    structured questions.
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
                        onChange={(e) =>
                          setResumeFile(e.target.files?.[0] || null)
                        }
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleResumeUpload}
                        disabled={!resumeFile || isSummarizingResume}
                      >
                        {isSummarizingResume
                          ? "Summarizing…"
                          : "Extract & Summarize"}
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
                      placeholder="e.g. Arrays, DP, REST APIs, system design basics, sales pipeline, objection handling…"
                      value={topicsText}
                      onChange={(e) => setTopicsText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="config-actions">
                  <button className="btn-primary" onClick={generateQuestions}>
                    Generate 3 Questions
                  </button>
                  <span className="hint-text">
                    You can tweak the questions before starting the interview.
                  </span>
                </div>
              </div>
            )}

            {editingQuestions.length > 0 && !interviewStarted && !scores && (
              <div className="card card-questions">
                <div className="card-header">
                  <h2>Question Set</h2>
                  <p className="card-subtitle">
                    Review depth and phrasing before the interview begins.
                  </p>
                </div>

                <div className="question-list">
                  {editingQuestions.map((q, idx) => (
                    <div key={q.id} className="question-item">
                      <div className="question-header">
                        <span className="question-label">
                          Question {idx + 1}
                        </span>
                        <span className={`type-pill type-${q.type}`}>
                          {q.type}
                        </span>
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
                    Start Voice Interview
                  </button>
                </div>
              </div>
            )}

            {interviewStarted && (
              <div className="card card-interview">
                <div className="interview-header">
                  <div>
                    <h2 className="interview-title">
                      Mock {currentRoleName} Interview
                    </h2>
                    <p className="interview-subtitle">
                      Expected duration: <strong>10 mins or less</strong>
                    </p>
                  </div>
                  <div className="interview-progress">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${((currentIndex + 1) / 3) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="progress-text">
                      Question {currentIndex + 1} of 3
                    </span>
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
                      Speak your answer. When you’re done, hit{" "}
                      <strong>Stop &amp; Send</strong>. You can also type
                      below.
                    </p>

                    <form onSubmit={handleTextSubmit}>
                      <textarea
                        className="field-input field-textarea"
                        placeholder="Fallback: type your answer here if voice fails or you prefer typing."
                        value={userInput}
                        onChange={(e) => setUserInput(e.target.value)}
                      />
                      <button type="submit" className="btn-secondary">
                        Send Typed Answer
                      </button>
                    </form>
                  </div>
                </div>

                <div className="interview-footer">
                  <div className="record-widget">
                    <div
                      className={`record-dot ${
                        isRecording ? "record-dot-on" : ""
                      }`}
                    />
                    <span className="record-time">
                      {isRecording ? "Recording" : "Idle"} •{" "}
                      {formatSeconds(recordSeconds)}
                    </span>
                    <button
                      className="btn-record"
                      onClick={stopRecording}
                      disabled={!isRecording}
                    >
                      ⏹ Stop &amp; Send
                    </button>
                  </div>

                  <div className="footer-actions">
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={handleSkipClick}
                    >
                      {skipStage === 0 ? "Skip Question" : "Skip Anyway"}
                    </button>
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => setShowTranscript((v) => !v)}
                    >
                      {showTranscript ? "Hide transcript" : "Show transcript"}
                    </button>
                  </div>
                </div>

                {showTranscript && (
                  <div className="transcript-panel">
                    {currentConversation.map((m, i) => (
                      <div key={i} className="transcript-line">
                        <span className="transcript-speaker">
                          {m.sender === "agent" ? "Agent" : "You"}:
                        </span>
                        <span>{m.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Right column */}
          <section className="column-right">
            <div className="card card-summary">
              <div className="card-header">
                <h2>Session Overview</h2>
                <p className="card-subtitle">
                  High-level summary, scores and qualitative feedback.
                </p>
              </div>

              {!scores && (
                <div className="empty-state">
                  <p>
                    Run an interview to see scores, strengths and areas to
                    improve. Your conversation is automatically analyzed once
                    all questions are complete.
                  </p>
                </div>
              )}

              {scores && feedback && (
                <>
                  <div className="score-grid">
                    <div className="score-card">
                      <div className="score-ring">
                        <div className="score-ring-inner">
                          {Math.round(scores.overall)}
                        </div>
                      </div>
                      <div className="score-label">Overall Hiring Score</div>
                      <p className="score-text">{feedback.summary}</p>
                    </div>

                    <div className="score-card">
                      <div className="score-ring small-ring">
                        <div className="score-ring-inner">
                          {scores.communication.toFixed(1)}
                        </div>
                      </div>
                      <div className="score-label">Communication</div>
                      <p className="score-text">
                        {feedback.strengths[0] || "Strong communication."}
                      </p>
                    </div>

                    <div className="score-card">
                      <div className="score-ring small-ring">
                        <div className="score-ring-inner">
                          {scores.technical.toFixed(1)}
                        </div>
                      </div>
                      <div className="score-label">Technical Depth</div>
                      <p className="score-text">
                        {feedback.improvements[0] ||
                          "Review core concepts for deeper coverage."}
                      </p>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div className="detail-card">
                      <h3>Strengths</h3>
                      <ul>
                        {feedback.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="detail-card">
                      <h3>Areas to Improve</h3>
                      <ul>
                        {feedback.improvements.map((s, i) => (
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
