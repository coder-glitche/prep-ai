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

print("GROQ KEY PREFIX:", (os.getenv("GROQ_API_KEY") or "")[:8])
print("LLM MODEL:", LLM_MODEL)
print("WHISPER MODEL:", WHISPER_MODEL)

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
    allow_methods=["*"],   # very important for OPTIONS
    allow_headers=["*"],   # allow all headers in preflight
)

RESULTS_FILE = os.path.join(BASE_DIR, "results.csv")


# ---------- Models ----------
class Question(BaseModel):
    id: int
    type: str     # "technical" | "project" | "behavioral"
    text: str


class GenerateRequest(BaseModel):
    role: str
    resume_summary: Optional[str] = None
    topics: Optional[str] = None   # e.g. "Arrays, DP, REST APIs"


class GenerateResponse(BaseModel):
    role: str
    questions: List[Question]


class Message(BaseModel):
    sender: str = Field(..., description="'agent' or 'candidate'")
    text: str


class AnswerRequest(BaseModel):
    role: str
    question: Question
    conversation: List[Message] = []
    followup_count: int = 0
    elapsed_minutes: float = 0.0


class AnswerResponse(BaseModel):
    reply: str
    done: bool


class QAItem(BaseModel):
    question: str
    conversation: List[Message]
    summary: Optional[str] = None
    remarks: Optional[str] = None
    score: Optional[float] = None   # 0–10 per question


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


class SummaryRequest(BaseModel):
    role: str
    question: str
    conversation: List[Message]


class SummaryResponse(BaseModel):
    summary: str
    remarks: str
    score: float


class SkipRequest(BaseModel):
    role: str
    question: Question
    conversation: List[Message] = []
    attempt: int = 0  # 0 = offer hint; 1 = confirm skip


class SkipResponse(BaseModel):
    reply: str
    done: bool


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
def call_llm_as_json(prompt: str, schema_description: str) -> dict:
    """
    Call Groq chat completion and expect a single JSON object in the response.
    """
    system_message = (
        "You are a helpful interview coach. "
        "Always respond with a single valid JSON object and nothing else. "
        f"The JSON schema is: {schema_description}"
    )

    completion = client.chat.completions.create(
        model=LLM_MODEL,
        temperature=0.25,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
    )

    text = completion.choices[0].message.content.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            return json.loads(text[start : end + 1])
        raise


def extract_pdf_text(path: str) -> str:
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


# ---------- Basic endpoints ----------
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

You are an expert interview question designer.
Generate exactly THREE interview questions:

1. A technical / role-specific question focusing on the given topics.
2. A question about previous projects or the resume summary.
3. A behavioral / soft skills question.

Return a JSON object only:
{{
  "questions": [
    {{ "id": 1, "type": "technical", "text": "..." }},
    {{ "id": 2, "type": "project", "text": "..." }},
    {{ "id": 3, "type": "behavioral", "text": "..." }}
  ]
}}
    """

    data = call_llm_as_json(prompt, "questions: list of 3 objects with id, type, text")
    questions = [Question(**q) for q in data["questions"]]
    return GenerateResponse(role=role, questions=questions)


# ---------- Answer / follow-ups (max 1 follow-up) ----------
@app.post("/api/answer", response_model=AnswerResponse)
def answer_question(payload: AnswerRequest):
    """
    Candidate can answer at most twice:
    - initial answer (followup_count = 0)
    - one follow-up answer (followup_count = 1)
    After that, the agent must be done and give feedback for this question.
    """
    q = payload.question
    role = payload.role

    conv_text = ""
    for m in payload.conversation:
        conv_text += f"{m.sender.upper()}: {m.text}\n"

    prompt = f"""
You are playing the role of a human interviewer for the role: {role}.
The current question is: "{q.text}"

Conversation so far for THIS question:
{conv_text}

Current follow-up count: {payload.followup_count}
Elapsed time on this question (minutes): {payload.elapsed_minutes:.2f}

Rules:
- The candidate is allowed to answer at most twice for this question.
- When follow-up count is 0, you may:
  - either be satisfied and close the question (done = true), OR
  - ask ONE short follow-up question (done = false).
- When follow-up count is 1 or more, you MUST be satisfied and close the question (done = true).
- Your response should be brief, natural, and encouraging.
- If their answer is weak or incomplete, gently highlight a key missing point in your closing comment.

Return JSON ONLY:
{{
  "reply": "Your short response or follow-up question in natural language.",
  "done": true or false
}}
    """

    data = call_llm_as_json(prompt, "reply: string, done: boolean")
    done_value = bool(data["done"])
    # Force done if followup_count >= 1
    if payload.followup_count >= 1:
        done_value = True

    return AnswerResponse(reply=data["reply"], done=done_value)


# ---------- Per-question summarization + score ----------
@app.post("/api/summarize-answer", response_model=SummaryResponse)
def summarize_answer(payload: SummaryRequest):
    conv_text = ""
    for m in payload.conversation:
        conv_text += f"{m.sender.upper()}: {m.text}\n"

    prompt = f"""
You are an interview coach.

Question:
{payload.question}

Conversation for this question (agent + candidate):
{conv_text}

1. In 3–5 sentences, summarize the candidate's answer in neutral, objective terms.
2. In 2–3 sentences, give remarks on correctness, depth, and communication.
3. Assign a single numeric score from 0 to 10 for this question, where:
   - 0–3 = poor / mostly incorrect,
   - 4–6 = partially correct or shallow,
   - 7–8 = good,
   - 9–10 = excellent.

Return JSON ONLY:
{{
  "summary": "summary text",
  "remarks": "remarks text",
  "score": 0-10 (number)
}}
    """

    data = call_llm_as_json(prompt, "summary: string, remarks: string, score: number 0-10")
    score_val = float(data.get("score", 0.0))
    return SummaryResponse(summary=data["summary"], remarks=data["remarks"], score=score_val)


# ---------- Evaluation ----------
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

Here is the full interview (including per-question scores, summaries and remarks if present):
----------------
{transcript}
----------------

Provide a concise evaluation.

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
    "strengths": ["bullet", "points"],
    "improvements": ["bullet", "points"],
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
    """
    Use Groq Whisper model to transcribe audio.
    """
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
async def resume_summary(
    file: UploadFile = File(...),
    role: str = Form(""),
):
    """
    Upload a resume PDF. Extract text and summarize for the given role.
    """
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


# ---------- Skip / hint flow ----------
@app.post("/api/skip-question", response_model=SkipResponse)
def skip_question(payload: SkipRequest):
    """
    attempt = 0: candidate clicks 'Skip' for the first time.
                -> Offer a gentle hint + encouragement to try.
    attempt = 1: candidate confirms skip.
                -> Acknowledge skip, keep it positive, and end question.
    """
    q = payload.question
    role = payload.role

    conv_text = ""
    for m in payload.conversation:
        conv_text += f"{m.sender.upper()}: {m.text}\n"

    if payload.attempt == 0:
        prompt = f"""
You are an interviewer for the role: {role}.
Current question: "{q.text}"

Conversation so far:
{conv_text}

The candidate clicked 'Skip' for the first time.

Respond with a SHORT, friendly message which:
- acknowledges that the question may feel challenging,
- offers a concise HINT or a way to think about the question,
- encourages them to give it a try before skipping.

Return JSON ONLY:
{{
  "reply": "short hint + encouragement",
  "done": false
}}
        """
        data = call_llm_as_json(prompt, "reply: string, done: boolean (false)")
        return SkipResponse(reply=data["reply"], done=False)

    # attempt >= 1 -> confirm skip and end question
    prompt = f"""
You are an interviewer for the role: {role}.
Current question: "{q.text}"

Conversation so far:
{conv_text}

The candidate confirmed they want to skip this question, even after a hint.

Reply with a SHORT, friendly message which:
- respects their choice,
- briefly normalizes that skipping is okay in practice sessions,
- transitions to the next question.

Return JSON ONLY:
{{
  "reply": "short closing message about skipping this question",
  "done": true
}}
    """
    data = call_llm_as_json(prompt, "reply: string, done: boolean (true)")
    return SkipResponse(reply=data["reply"], done=True)
