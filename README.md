# Prep.AI – Voice Interview Practice Agent

Prep.AI is a **full-stack voice-based mock interview agent** built with FastAPI, React, Groq Whisper STT, and browser TTS.

---

## ✨ Features

- Generates **3 role-specific questions**
  - Technical
  - Project/Resume
  - Behavioural
- Runs a **conversational voice interview**
  - STT: Groq Whisper `whisper-large-v3-turbo`
  - TTS: Browser SpeechSynthesis API
- Maximum **1 follow-up question** per main question
- **Skip question** flow with hint
- **Summaries & scores** each answer
- Generates an **overall evaluation**
- Saves results into **CSV** for later analysis

---

## 🏗 Tech Stack

### **Backend**
- FastAPI  
- Uvicorn  
- Groq SDK  
- Whisper STT  
- PyPDF  

### **Frontend**
- React + Vite  

### **Voice**
- STT: Groq Whisper  
- TTS: Browser SpeechSynthesis API

---

---

# 🔧 Prerequisites

## 2.1 System & Python

**Requirements**
- Ubuntu 22.04
- Python 3.10+
- pip & venv

Install Python tools:

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv


---



