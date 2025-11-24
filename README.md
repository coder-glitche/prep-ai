# Prep.AI – Voice Interview Practice Agent

Prep.AI is a full-stack, **voice-first interview practice platform**.  
It simulates a realistic one-on-one interview where an AI interviewer:

- Generates role-specific questions (e.g. SDE, Sales)
- Reads and summarizes the candidate’s resume (PDF)
- Conducts a spoken interview using voice in both directions
- Listens to answers, optionally asks a follow-up, and then moves on
- Evaluates performance and provides structured feedback + scores

The UI is inspired by modern interview analytics tools, with a dashboard for configuring an interview and a panel for reviewing results.

---

## 📝 Project Description

### Core Workflow

1. **Configure interview**
   - Select a role (Software Development Engineer, Sales, …).
   - Upload a resume (PDF) and optionally type in technical topics.
   - Backend extracts & summarizes the resume, then generates **3 questions**:
     - 1 technical / role-specific
     - 1 project / resume-based
     - 1 behavioral
   - You can edit all questions before starting.

2. **Run voice interview**
   - AI interviewer speaks each question via browser text-to-speech.
   - Candidate answers via microphone; audio is recorded in the browser.
   - Audio is sent to the backend and transcribed with **Groq Whisper**.
   - The interviewer may ask a concise follow-up, then closes the question.

3. **Skip & hint flow**
   - Candidate can click **Skip Question**:
     - First click → interviewer gives a hint and encourages an attempt.
     - Second click → interviewer acknowledges the skip and continues.

4. **Scoring & feedback**
   - Backend summarizes each question’s conversation and assigns a score.
   - After all questions, an overall evaluation is generated:
     - Technical score
     - Communication score
     - Role-fit score
     - Overall hiring score
   - Feedback includes strengths, areas for improvement, and next steps.

5. **Result logging**
   - All results (scores, feedback, question-level summaries) are stored in a CSV file for later analysis.

---

## 🧱 Tech Stack

### Frontend

- **React** (Vite)
- Modern custom **CSS**
- Browser APIs:
  - `speechSynthesis` (Web Speech API) for text-to-speech
  - `getUserMedia` + `MediaRecorder` for microphone capture
- Axios for HTTP requests

### Backend

- **Python 3.10+**
- **FastAPI** (REST API)
- **Uvicorn** (ASGI server)
- **Groq Python SDK**
  - LLM for question generation, feedback & scoring
  - Whisper for speech-to-text
- **python-dotenv** for environment variables
- **pypdf** for PDF text extraction
- CSV storage for interview results

### AI Models (via Groq)

Configured through environment variables:

- LLM (default): `llama-3.1-8b-instant`
- STT: `whisper-large-v3-turbo`

---

## ⚙️ Setup

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/interview-practice-agent.git
cd interview-practice-agent
