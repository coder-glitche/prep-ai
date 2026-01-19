import os
import json
import csv
import datetime
import tempfile
from typing import List, Dict, Optional, Any

from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from groq import Groq
from pypdf import PdfReader

# ---------- Setup ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(BASE_DIR, ".env")
load_dotenv(dotenv_path=env_path)

client = Groq(api_key=os.getenv("GROQ_API_KEY"))
LLM_MODEL = os.getenv("GROQ_LLM_MODEL", "llama-3.1-8b-instant")
WHISPER_MODEL = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")

app = FastAPI(title="Prep.AI Interview Voice Agent")

origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://prep-ai-theta-five.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

RESULTS_FILE = os.path.join(BASE_DIR, "results.csv")


# ---------- Models ----------
class Question(BaseModel):
    id: int
    type: str
    text: str


class GenerateRequest(BaseModel):
    role: str
    resume_summary: Optional[str] = None
    topics: Optional[str] = None


class GenerateResponse(BaseModel):
    role: str
    questions: List[Question]


class Message(BaseModel):
    sender: str = Field(..., description="'agent' or 'candidate'")
    text: str


class QAItem(BaseModel):
    question: str
    conversation: List[Message]
    summary: Optional[str] = None
    remarks: Optional[str] = None
    score: Optional[float] = None


class EvaluateRequest(BaseModel):
    role: str
    qa: List[QAItem]


class EvaluateResponse(BaseModel):
    scores: Dict[str, float]
    feedback: Dict[str, Any]


class SaveResultRequest(BaseModel):
    role: str
    resume_summary: Optional[str] = None
    topics: Optional[str] = None
    qa: List[QAItem]
    scores: Dict[str, float]
    feedback: Dict[str, Any]


class TranscribeResponse(BaseModel):
    text: str


class ResumeSummaryResponse(BaseModel):
    summary: str


class RespondRequest(BaseModel):
    role: str
    question: Question
    candidate_answer: str


class RespondResponse(BaseModel):
    # NOTE: reply is the ONLY thing the user should see per-question (no hints, no follow-ups)
    reply: str
    # below fields are for your final evaluation + storage
    summary: str
    remarks: str
    score: float


class SkipRequest(BaseModel):
    role: str
    question: Question


class SkipResponse(BaseModel):
    reply: str
    summary: str
    remarks: str
    score: float


# ---------- Validation debug (422) ----------
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    body = await request.body()
    print("Validation error on path:", request.url.path)
    print("Raw body:", body.decode("utf-8"))
    print("Errors:", exc.errors())
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": body.decode("utf-8")},
    )


# ---------- Helpers ----------
def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def call_llm_as_json(prompt: str, schema_description: str) -> dict:
    system_message = (
        "You are a strict JSON generator. "
        "Return exactly ONE valid JSON object and nothing else (no markdown, no extra text). "
        f"Schema: {schema_description}"
    )

    completion = client.chat.completions.create(
        model=LLM_MODEL,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
    )

    text = completion.choices[0].message.content or ""
    return _extract_json(text)


def extract_pdf_text(path: str) -> str:
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


# ---------- Basic endpoints ----------
@app.get("/")
def root():
    return {"message": "Prep.AI backend is running. Try /api/health or /docs"}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/roles")
def list_roles():
    return {
        "roles": [
            {"id": "sde", "name": "Software Development Engineer (SDE)"},
            {"id": "sales", "name": "Sales / Business Development"},
        ]
    }


# ---------- Question generation ----------
@app.post("/api/generate-questions", response_model=GenerateResponse)
def generate_questions(payload: GenerateRequest):
    role = payload.role
    resume_summary = payload.resume_summary or "Not provided."
    topics = payload.topics or "General fundamentals for this role."

    prompt = f"""
Role: {role}

Resume / profile summary:
{resume_summary}

Technical topics to focus on:
{topics}

Generate exactly THREE interview questions:
1) technical (role-specific, based on topics)
2) project (based on resume summary)
3) behavioral (soft skills)

Return JSON only:
{{
  "questions": [
    {{ "id": 1, "type": "technical", "text": "..." }},
    {{ "id": 2, "type": "project", "text": "..." }},
    {{ "id": 3, "type": "behavioral", "text": "..." }}
  ]
}}
"""

    data = call_llm_as_json(prompt, "questions: array of 3 objects {id:int,type:str,text:str}")
    questions = [Question(**q) for q in data["questions"]]
    return GenerateResponse(role=role, questions=questions)


# ---------- Single-answer response (NO FOLLOW-UP, NO HINTS) ----------
@app.post("/api/respond", response_model=RespondResponse)
def respond(payload: RespondRequest):
    role = payload.role
    q = payload.question
    ans = (payload.candidate_answer or "").strip()

    # Critical: feedback only; no coaching, no hints, no follow-up questions.
    prompt = f"""
You are acting as an interviewer for the role: {role}.

You must do the following:
- Provide EXACTLY ONE feedback message about the candidate's answer.
- DO NOT ask any follow-up question.
- DO NOT give hints, coaching steps, "you should...", "next time...", "try to...", or "consider...".
- DO NOT mention what the candidate should say next.
- Keep feedback concise and evaluative only (2–3 sentences max).
- Provide an objective internal summary + remarks for scoring (not user-facing), still without advice language.

Question:
"{q.text}"

Candidate answer:
"{ans}"

Return JSON ONLY in this schema:
{{
  "reply": "2-3 sentences of evaluative feedback only (no hints, no follow-up questions).",
  "summary": "1-2 sentences factual summary of what candidate said (no advice).",
  "remarks": "1-2 sentences assessment of correctness/depth/clarity (no advice).",
  "score": 0-10
}}
"""

    data = call_llm_as_json(prompt, "reply:str, summary:str, remarks:str, score:number(0-10)")
    return RespondResponse(
        reply=str(data.get("reply", "")).strip(),
        summary=str(data.get("summary", "")).strip(),
        remarks=str(data.get("remarks", "")).strip(),
        score=float(data.get("score", 0.0)),
    )


# ---------- Skip (NO HINTS) ----------
@app.post("/api/skip", response_model=SkipResponse)
def skip(payload: SkipRequest):
    role = payload.role
    q = payload.question

    prompt = f"""
You are acting as an interviewer for the role: {role}.

The candidate skipped the question:
"{q.text}"

Rules:
- Reply must be a short acknowledgement only (1 sentence).
- No hints, no coaching, no "you should revisit" advice, no follow-up questions.

Return JSON ONLY:
{{
  "reply": "Short acknowledgement only.",
  "summary": "Candidate skipped this question.",
  "remarks": "No answer provided.",
  "score": 0
}}
"""
    data = call_llm_as_json(prompt, "reply, summary, remarks, score")
    return SkipResponse(
        reply=str(data.get("reply", "")).strip(),
        summary=str(data.get("summary", "Candidate skipped this question.")).strip(),
        remarks=str(data.get("remarks", "No answer provided.")).strip(),
        score=float(data.get("score", 0.0)),
    )


# ---------- Evaluation (final only) ----------
@app.post("/api/evaluate", response_model=EvaluateResponse)
def evaluate_interview(payload: EvaluateRequest):
    role = payload.role

    transcript_parts = []
    for i, qa in enumerate(payload.qa, start=1):
        transcript_parts.append(f"Question {i}: {qa.question}")
        for m in qa.conversation:
            transcript_parts.append(f"{m.sender.upper()}: {m.text}")
        if qa.summary:
            transcript_parts.append(f"SUMMARY: {qa.summary}")
        if qa.remarks:
            transcript_parts.append(f"REMARKS: {qa.remarks}")
        if qa.score is not None:
            transcript_parts.append(f"QUESTION_SCORE: {qa.score}")
        transcript_parts.append("")

    transcript = "\n".join(transcript_parts)

    prompt = f"""
You are an interview coach evaluating a candidate for the role: {role}.

Full interview transcript:
----------------
{transcript}
----------------

Return JSON ONLY:
{{
  "scores": {{
    "communication": number 0-10,
    "technical": number 0-10,
    "roleFit": number 0-10,
    "overall": number 0-10
  }},
  "feedback": {{
    "summary": "2-3 sentence overall summary.",
    "strengths": ["short bullet", "short bullet"],
    "improvements": ["short bullet", "short bullet"],
    "nextSteps": "short 2-3 sentence guidance."
  }}
}}
"""
    data = call_llm_as_json(prompt, "scores + feedback as described")
    return EvaluateResponse(scores=data["scores"], feedback=data["feedback"])


# ---------- Save result to CSV ----------
@app.post("/api/save-result")
def save_result(payload: SaveResultRequest):
    row = {
        "timestamp": datetime.datetime.utcnow().isoformat(),
        "role": payload.role,
        "resume_summary": payload.resume_summary or "",
        "topics": payload.topics or "",
        "scores": json.dumps(payload.scores, ensure_ascii=False),
        "feedback": json.dumps(payload.feedback, ensure_ascii=False),
        "qa": json.dumps([qa.model_dump() for qa in payload.qa], ensure_ascii=False),
    }

    file_exists = os.path.exists(RESULTS_FILE)
    with open(RESULTS_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=row.keys())
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)

    return {"status": "ok"}


# ---------- STT via Groq Whisper ----------
@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as audio_file:
            transcription = client.audio.transcriptions.create(
                file=audio_file,
                model=WHISPER_MODEL,
                response_format="json",
                temperature=0.0,
            )
        text = transcription.text.strip()
    finally:
        os.remove(tmp_path)

    return TranscribeResponse(text=text)


# ---------- Resume PDF → summary ----------
@app.post("/api/resume-summary", response_model=ResumeSummaryResponse)
async def resume_summary(file: UploadFile = File(...), role: str = Form("")):
    suffix = os.path.splitext(file.filename or "")[1] or ".pdf"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        raw_text = extract_pdf_text(tmp_path)
    finally:
        os.remove(tmp_path)

    prompt = f"""
You are an interview assistant preparing for a {role} interview.

Summarize this resume in 6–8 sentences. Focus on:
- key skills,
- main projects,
- achievements relevant to {role},
- anything that can be turned into a good project-based interview question.

Resume text:
----------------
{raw_text}
----------------
"""
    completion = client.chat.completions.create(
        model=LLM_MODEL,
        temperature=0.3,
        messages=[
            {"role": "system", "content": "You write concise, interview-focused summaries."},
            {"role": "user", "content": prompt},
        ],
    )
    summary_text = completion.choices[0].message.content.strip()
    return ResumeSummaryResponse(summary=summary_text)

