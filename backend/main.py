import os
import json
from typing import List, Dict, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from groq import Groq

# ----- Setup -----
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(BASE_DIR, ".env")
load_dotenv(dotenv_path=env_path)   # <-- explicit path

client = Groq(api_key=os.getenv("GROQ_API_KEY"))
MODEL = os.getenv("GROQ_MODEL_TEXT", "llama-3.1-8b-instant")

print("GROQ API KEY PREFIX:", (os.getenv("GROQ_API_KEY") or "")[:8])


app = FastAPI(title="Interview Practice Agent")

origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----- Data Models -----
class Question(BaseModel):
    id: int
    type: str  # "technical" | "project" | "behavioral"
    text: str

class GenerateRequest(BaseModel):
    role: str
    resume_summary: Optional[str] = None

class GenerateResponse(BaseModel):
    role: str
    questions: List[Question]

class Message(BaseModel):
    sender: str = Field(..., description="'agent' or 'candidate'")
    text: str

class AnswerRequest(BaseModel):
    role: str
    question: Question
    conversation: List[Message]

class AnswerResponse(BaseModel):
    reply: str
    done: bool  # True when interviewer is satisfied and ready for next question

class QAItem(BaseModel):
    question: str
    conversation: List[Message]

class EvaluateRequest(BaseModel):
    role: str
    qa: List[QAItem]

class EvaluateResponse(BaseModel):
    scores: Dict[str, float]
    feedback: Dict[str, object]


# ----- Helper LLM Call (Groq) -----
def call_llm_as_json(prompt: str, schema_description: str) -> dict:
    """
    Calls Groq chat completions and expects a single JSON object back.
    schema_description is just a hint in the prompt.
    """
    system_message = (
        "You are a helpful interview coach. "
        "Always respond with a single valid JSON object and nothing else. "
        f"The JSON schema is: {schema_description}"
    )

    completion = client.chat.completions.create(
        model=MODEL,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
    )

    text = completion.choices[0].message.content.strip()
    # Try to parse JSON; if model adds junk, attempt a simple trim
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            return json.loads(text[start : end + 1])
        raise


# ----- API Endpoints -----
@app.get("/api/roles")
def list_roles():
    return {
        "roles": [
            {"id": "sde", "name": "Software Development Engineer (SDE)"},
            {"id": "sales", "name": "Sales Associate"},
        ]
    }


@app.post("/api/generate-questions", response_model=GenerateResponse)
def generate_questions(payload: GenerateRequest):
    role = payload.role
    resume_summary = payload.resume_summary or "Not provided."

    prompt = f"""
Role: {role}

You are an expert interview question designer. 
Generate exactly THREE interview questions for a mock interview:
1 technical / role-specific question
1 question about previous projects or resume
1 behavioral question.

Return a JSON object:
{{
  "questions": [
    {{ "id": 1, "type": "technical", "text": "..." }},
    {{ "id": 2, "type": "project", "text": "..." }},
    {{ "id": 3, "type": "behavioral", "text": "..." }}
  ]
}}

Tailor the questions to the role. 
Resume summary (if any): {resume_summary}
    """

    data = call_llm_as_json(prompt, "questions: list of 3 objects with id, type, text")
    questions = [Question(**q) for q in data["questions"]]
    return GenerateResponse(role=role, questions=questions)


@app.post("/api/answer", response_model=AnswerResponse)
def answer_question(payload: AnswerRequest):
    q = payload.question
    role = payload.role

    conv_text = ""
    for m in payload.conversation:
        conv_text += f"{m.sender.upper()}: {m.text}\n"

    prompt = f"""
You are playing the role of an interviewer for the role: {role}.
The current question is: "{q.text}"

Here is the conversation so far for THIS question:
{conv_text}

Decide whether:
- You still need ONE more follow-up question to probe deeper, OR
- You are satisfied and ready to move on to the next main question.

Return JSON:
{{
  "reply": "Your short response or follow-up question in natural language.",
  "done": true or false
}}

If you are satisfied, set "done" to true and make "reply" a brief closing comment.
If you want a follow-up, set "done" to false and make "reply" the follow-up question.
    """

    data = call_llm_as_json(prompt, "reply: string, done: boolean")
    return AnswerResponse(reply=data["reply"], done=data["done"])


@app.post("/api/evaluate", response_model=EvaluateResponse)
def evaluate_interview(payload: EvaluateRequest):
    role = payload.role

    transcript_parts = []
    for i, qa in enumerate(payload.qa, start=1):
        transcript_parts.append(f"Question {i}: {qa.question}")
        for m in qa.conversation:
            transcript_parts.append(f"{m.sender.upper()}: {m.text}")
        transcript_parts.append("")

    transcript = "\n".join(transcript_parts)

    prompt = f"""
You are an interview coach evaluating a candidate for the role: {role}.

Here is the full interview transcript:
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
