@echo off
echo Installing Trixie...
npm install
echo.
echo Please fill in your API keys in the .env file that was created.
echo Keys needed:
echo   GOOGLE_AI_STUDIO_KEY — from aistudio.google.com
echo   OPENAI_KEY — from platform.openai.com (for Whisper)
echo   ELEVENLABS_KEY — from elevenlabs.io
echo   ELEVENLABS_VOICE_ID — pick a voice from elevenlabs.io/voice-lab
echo   TAVILY_KEY — from tavily.com (free tier)
echo.
echo Once keys are filled in, run: npm start
pause
