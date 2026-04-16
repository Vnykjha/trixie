# Trixie — your JARVIS for college. Voice-activated AI that lives on your desktop.

> Wake her up with **"Hey Trixie"** or **Ctrl+Space**. She reads your files, explains your code, quizzes you before exams, writes your lab reports, and searches the web — all hands-free.

---

## Demo

<!-- Add a demo GIF here -->
![Trixie demo](demo.gif)

---

## What Trixie can do

- **Read and explain any file you're working on** — just say the filename
- **Quiz you on any topic** in full viva-exam style, then score you out of 10
- **Search the web** for anything and read back the top results
- **Write and save lab reports** to your Desktop after you dictate the bullet points
- **Generate cheat sheets** from your notes and save them as Markdown files
- **Run Python and JavaScript snippets** and read the output back to you
- **Open apps and websites** by name — Chrome, VS Code, Notepad, any URL

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) v18 or later
- [SoX](https://sourceforge.net/projects/sox/) installed and on your PATH (needed for microphone capture)

### Steps

1. **Clone the repo**
   ```
   git clone https://github.com/your-username/trixie.git
   cd trixie
   ```

2. **Run the setup script**
   ```
   setup.bat
   ```
   This installs dependencies and reminds you to fill in your `.env` file.

3. **Fill in your API keys** in `.env`, then launch:
   ```
   npm start
   ```

---

## API Keys

| Key | Where to get it | Required? |
|---|---|---|
| `GOOGLE_AI_STUDIO_KEY` | [aistudio.google.com](https://aistudio.google.com) | Yes (primary LLM) |
| `OPENAI_KEY` | [platform.openai.com](https://platform.openai.com) | Yes (Whisper STT) |
| `ELEVENLABS_KEY` | [elevenlabs.io](https://elevenlabs.io) | Optional (falls back to Windows SAPI) |
| `ELEVENLABS_VOICE_ID` | [elevenlabs.io/voice-lab](https://elevenlabs.io/voice-lab) | Optional |
| `TAVILY_KEY` | [tavily.com](https://tavily.com) | Optional (web search) |
| `GROQ_KEY` | [console.groq.com](https://console.groq.com) | Optional (LLM fallback) |

---

## Tech Stack

| Component | Technology |
|---|---|
| Desktop shell | [Electron](https://electronjs.org) |
| 3D visual | [Three.js](https://threejs.org) |
| Speech-to-text | [OpenAI Whisper](https://platform.openai.com/docs/guides/speech-to-text) |
| Language model | [Gemma 4 via Google AI Studio](https://aistudio.google.com) |
| LLM fallback | [Llama 3.1 via Groq](https://console.groq.com) |
| Text-to-speech | [ElevenLabs](https://elevenlabs.io) / Windows SAPI |
| Web search | [Tavily](https://tavily.com) |

---

## Example voice commands

```
"Hey Trixie, explain my main.py"
"Hey Trixie, start a viva on binary trees"
"Hey Trixie, search for quicksort time complexity"
"Hey Trixie, write a lab report for my networking practical"
"Hey Trixie, open Chrome"
"Hey Trixie, make a cheat sheet for operating systems"
"Hey Trixie, run this Python snippet"
```

---

## Keyboard shortcut

**Ctrl+Space** — toggle listening on/off (also interrupts speech)

---

## License

MIT
