import { useEffect, useState, useRef } from "react";
import axios from "axios";

const API_BASE = "http://localhost:8000";

function App() {
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState("");
  const [questions, setQuestions] = useState([]);
  const [editingQuestions, setEditingQuestions] = useState([]);
  const [interviewStarted, setInterviewStarted] = useState(false);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentConversation, setCurrentConversation] = useState([]);
  const [allQA, setAllQA] = useState([]);

  const [agentMessage, setAgentMessage] = useState("");
  const [userInput, setUserInput] = useState("");

  const [scores, setScores] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const [hasSpeech, setHasSpeech] = useState(false);
  const recognitionRef = useRef(null);

  // Text-to-speech helper
  const speak = (text) => {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  };

  // On mount, load roles & setup speech recognition
  useEffect(() => {
    axios.get(`${API_BASE}/api/roles`).then((res) => {
      setRoles(res.data.roles);
    });

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recog = new SpeechRecognition();
      recog.lang = "en-US";
      recog.continuous = false;
      recog.interimResults = false;
      recog.onresult = (event) => {
        const text = event.results[0][0].transcript;
        handleUserAnswer(text);
      };
      recognitionRef.current = recog;
      setHasSpeech(true);
    }
  }, []);

  const generateQuestions = async () => {
    if (!selectedRole) return alert("Please select a role first.");
    const res = await axios.post(`${API_BASE}/api/generate-questions`, {
      role: selectedRole,
    });
    setQuestions(res.data.questions);
    setEditingQuestions(res.data.questions.map((q) => ({ ...q })));
    setInterviewStarted(false);
    setScores(null);
    setFeedback(null);
    setAllQA([]);
    setCurrentConversation([]);
    setCurrentIndex(0);
  };

  const startInterview = () => {
    if (editingQuestions.length !== 3) {
      return alert("You must have exactly 3 questions.");
    }
    setQuestions(editingQuestions);
    setInterviewStarted(true);
    setCurrentIndex(0);
    setCurrentConversation([]);
    setAllQA([]);

    const firstQ = editingQuestions[0];
    const msg = `Let's start. ${firstQ.text}`;
    setAgentMessage(msg);
    speak(msg);
  };

  const startVoice = () => {
    if (!recognitionRef.current) return;
    recognitionRef.current.start();
  };

  const handleUserAnswer = async (textFromUser) => {
    const trimmed = textFromUser.trim();
    if (!trimmed) return;

    const updatedConversation = [
      ...currentConversation,
      { sender: "candidate", text: trimmed },
    ];
    setCurrentConversation(updatedConversation);
    setUserInput("");

    const currentQ = questions[currentIndex];

    const res = await axios.post(`${API_BASE}/api/answer`, {
      role: selectedRole,
      question: currentQ,
      conversation: updatedConversation,
    });

    const { reply, done } = res.data;
    const newConvWithAgent = [
      ...updatedConversation,
      { sender: "agent", text: reply },
    ];
    setCurrentConversation(newConvWithAgent);
    setAgentMessage(reply);
    speak(reply);

    if (done) {
      // Save QA for this question
      const newAllQA = [
        ...allQA,
        {
          question: currentQ.text,
          conversation: newConvWithAgent,
        },
      ];
      setAllQA(newAllQA);

      if (currentIndex + 1 < questions.length) {
        const nextIndex = currentIndex + 1;
        setCurrentIndex(nextIndex);
        setCurrentConversation([]);

        const nextQ = questions[nextIndex];
        const qText = `Next question: ${nextQ.text}`;
        setAgentMessage(qText);
        speak(qText);
      } else {
        // Interview finished
        finishInterview(newAllQA);
      }
    }
  };

  const finishInterview = async (qaData) => {
    const res = await axios.post(`${API_BASE}/api/evaluate`, {
      role: selectedRole,
      qa: qaData,
    });
    setScores(res.data.scores);
    setFeedback(res.data.feedback);

    const closing =
      "Thanks for completing the mock interview. I've generated your scores and feedback.";
    speak(closing);
  };

  const handleTextSubmit = (e) => {
    e.preventDefault();
    handleUserAnswer(userInput);
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <h1>Interview Practice Partner</h1>
      <p>
        Select a role, generate questions, optionally edit them, then start a
        voice-based mock interview.
      </p>

      {/* Role selection */}
      <section style={{ marginBottom: 16 }}>
        <label>
          Role:&nbsp;
          <select
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
          >
            <option value="">-- choose --</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button style={{ marginLeft: 8 }} onClick={generateQuestions}>
          Generate 3 Questions
        </button>
      </section>

      {/* Question editing */}
      {editingQuestions.length > 0 && !interviewStarted && (
        <section style={{ marginBottom: 16 }}>
          <h2>Edit Questions</h2>
          {editingQuestions.map((q, idx) => (
            <div
              key={q.id}
              style={{ marginBottom: 12, padding: 8, border: "1px solid #ccc" }}
            >
              <div>
                <strong>{q.type.toUpperCase()}</strong>
              </div>
              <textarea
                style={{ width: "100%", minHeight: 60 }}
                value={q.text}
                onChange={(e) => {
                  const clone = [...editingQuestions];
                  clone[idx] = { ...clone[idx], text: e.target.value };
                  setEditingQuestions(clone);
                }}
              />
            </div>
          ))}
          <button onClick={startInterview}>Start Interview</button>
        </section>
      )}

      {/* Interview section */}
      {interviewStarted && (
        <section style={{ marginBottom: 16 }}>
          <h2>Live Interview</h2>
          <p>
            <strong>Interviewer:</strong> {agentMessage}
          </p>

          <div style={{ marginBottom: 8 }}>
            <button onClick={startVoice} disabled={!hasSpeech}>
              🎤 Answer with Voice
            </button>
            {!hasSpeech && (
              <span style={{ marginLeft: 8, color: "red" }}>
                Browser speech API not available; use text box below.
              </span>
            )}
          </div>

          <form onSubmit={handleTextSubmit}>
            <textarea
              style={{ width: "100%", minHeight: 60 }}
              placeholder="Or type your answer here..."
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
            />
            <button type="submit" style={{ marginTop: 8 }}>
              Send Answer
            </button>
          </form>

          <h3>Conversation for this question</h3>
          <div
            style={{
              maxHeight: 200,
              overflowY: "auto",
              border: "1px solid #ddd",
              padding: 8,
            }}
          >
            {currentConversation.map((m, idx) => (
              <div key={idx}>
                <strong>{m.sender === "agent" ? "Agent" : "You"}:</strong>{" "}
                {m.text}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Results */}
      {scores && feedback && (
        <section>
          <h2>Performance Metrics</h2>
          <ul>
            <li>Communication: {scores.communication.toFixed(1)} / 10</li>
            <li>Technical: {scores.technical.toFixed(1)} / 10</li>
            <li>Role Fit: {scores.roleFit.toFixed(1)} / 10</li>
            <li>Overall: {scores.overall.toFixed(1)} / 10</li>
          </ul>

          <h3>Feedback Summary</h3>
          <p>{feedback.summary}</p>

          <h4>Strengths</h4>
          <ul>
            {feedback.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>

          <h4>Areas to Improve</h4>
          <ul>
            {feedback.improvements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>

          <h4>Next Steps</h4>
          <p>{feedback.nextSteps}</p>
        </section>
      )}
    </div>
  );
}

export default App;
