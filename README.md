# Prep.AI – Voice Interview Practice Agent

Prep.AI is a full-stack voice-based mock interview agent. This document includes: tech stack, setup, and run instructions for both backend and frontend.

To solve the issue of conversational AI voice agents instead of using readily available APIs or voice agents from ELEVEN LABS or VAPI which are costly 
Ive built this interviewer voice agent using open - source models like 

- Llama 3.1 - 8b instant model for Natural Language processing, conversation flow , memory and knowledge base handling , Resume summarization, Candidate Scoring and feedback generation
- OpenAI whispher large turbo for Speech to Text (transcription).
- Browser SpeechSynthesis for Text to Speech (voice generation).


## Features

It can:
- Generate 3 role-specific questions (Technical, Project/Resume, Behavioural)
- Run a conversational voice interview (Groq Whisper STT + browser TTS)
- Ask at most 1 follow-up per question (2 answers max per question)
- Allow skipping questions (with hint → skip flow)
- Summarize & score each question and generate an overall evaluation
- Store results in a CSV file for later analysis

## Tech Stack

- **Backend:** FastAPI, Uvicorn, Groq Python SDK, Whisper STT, pypdf
- **Frontend:** React + Vite
- **Voice:**
  - STT: Groq whisper-large-v3-turbo
  - TTS: Browser SpeechSynthesis API
- **OS:** Ubuntu 22.04 (developer machine)

## Project Structure (Top Level)
```
interview-practice-agent/
├── backend/
└── frontend/
```

## Prerequisites

### 2.1. System & Python

**Required:**
- OS: Ubuntu 22.04
- Python: 3.10+
- Tools: pip, venv

**Install Python and tooling:**
```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv
```

### 2.2. Node.js (for Vite)

Vite requires Node 20.19+ or 22.12+. Use nvm:

**Install nvm (if you don't have it):**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc # or ~/.zshrc
```

**Install and use Node 22 (recommended):**
```bash
nvm install 22
nvm use 22
```

**Confirm installation:**
```bash
node -v # v22.x.x
npm -v
```

### 2.3. Groq API Key

Create a `.env` file in `backend/`:
```bash
cd interview-practice-agent/backend
nano .env
```

Add the following:
```env
GROQ_API_KEY=your_real_groq_api_key_here
GROQ_LLM_MODEL=llama-3.1-8b-instant
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
```

Save and exit.

## Backend Setup (FastAPI + Groq)

From the project root:
```bash
cd interview-practice-agent/backend
```

**Create and activate virtualenv:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

**Install dependencies:**
```bash
pip install --upgrade pip
pip install fastapi uvicorn[standard] python-dotenv groq pypdf anyio
```

If you have a `requirements.txt` in `backend/`, you can instead run:
```bash
pip install -r requirements.txt
```

### 3.1. Run Backend
```bash
cd interview-practice-agent/backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

You should see logs like:
```
Uvicorn running on http://127.0.0.1:8000
INFO: 127.0.0.1:... "GET /api/roles HTTP/1.1" 200 OK
```

### 3.2. Key Backend Endpoints

For reference:
- `GET /api/health` – health check
- `GET /api/roles` – available roles (e.g., SDE, Sales)
- `POST /api/generate-questions` – generate 3 role-specific questions
- `POST /api/transcribe` – audio → text (Groq Whisper)
- `POST /api/answer` – agent follow-up for a single question
- `POST /api/summarize-answer` – per-question summary + score
- `POST /api/skip-question` – hint + skip flow
- `POST /api/evaluate` – overall scores + feedback
- `POST /api/save-result` – save CSV (backend/results.csv)
- `POST /api/resume-summary` – resume PDF → summary

## Frontend Setup (React + Vite)

In another terminal:
```bash
cd interview-practice-agent/frontend
```

**Ensure Node 22 is active:**
```bash
nvm use 22
```

**Install dependencies:**
```bash
npm install
```

(If Vite was already scaffolded earlier, `package.json` is already set up.)

### 4.1. Run Frontend Dev Server
```bash
cd interview-practice-agent/frontend
nvm use 22
npm run dev
```

Vite will show something like:
```
Local: http://localhost:5173/
```

Open that URL in your browser (Chrome recommended).

## ⚠️ Important

Keep both:
- **Backend** → `http://localhost:8000` (Uvicorn)
- **Frontend** → `http://localhost:5173` (Vite)

running in separate terminals for Prep.AI to work properly.
