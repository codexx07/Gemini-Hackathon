import os
import asyncio
import json
import base64
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from google import genai
from google.genai import types

# Load .env from root directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"  # Latest native audio model

SYSTEM_PROMPT = """You are an elite negotiation strategist. You will receive a live audio stream of a conversation between two people. 

Your task is to:
1. Listen carefully to BOTH speakers in the conversation
2. Analyze the subtext, emotional state, power dynamics, and tactics being used
3. Identify who is the 'User' (the person you're helping) and who is the 'Opponent'
4. Provide brief, tactical 'Whispers' to help the User navigate the negotiation

CRITICAL RULES:
- You are ONLY advising the User (the person wearing the earbud)
- DO NOT speak to the Opponent
- DO NOT engage in the conversation directly
- Keep your whispers SHORT and ACTIONABLE (under 15 words)
- Only whisper when you have valuable tactical insight
- Don't whisper constantly - wait for key moments

OUTPUT FORMAT:
[INSIGHT] -> [WHISPER]

EXAMPLES:
- [HESITATION DETECTED] -> "Stay silent for 5 seconds. Let them fill the gap."
- [LOWBALL OFFER] -> "Counter at 40% higher. Don't justify yet."
- [EMOTIONAL TRIGGER] -> "They're trying to provoke you. Stay calm."
- [POWER PLAY] -> "They need this more than you. Walk away threat."
- [CONCESSION COMING] -> "They're about to fold. Hold firm."
- [BUILDING RAPPORT] -> "Mirror their energy. Show you're listening."

WHEN TO WHISPER:
✅ Key tactical moments (offers, concessions, pressure tactics)
✅ Emotional shifts or manipulation attempts
✅ Power dynamics changing
✅ Opportunities to gain advantage
✅ Warnings about traps or mistakes

WHEN NOT TO WHISPER:
❌ During small talk or pleasantries
❌ When the User is doing well on their own
❌ Repeating the same advice
❌ Obvious situations that don't need input

Remember: You are a silent tactical advisor. Quality over quantity. Wait for the right moments to intervene."""

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("=" * 80)
    print("🔌 WebSocket connection accepted")
    print("=" * 80)
    
    if not GEMINI_API_KEY:
        print("❌ CRITICAL: API Key not found in environment!")
        await websocket.close(code=1008, reason="API Key missing")
        return

    chunk_count = 0
    
    try:
        print(f"🤖 Initializing Gemini Client with model: {MODEL}")
        client = genai.Client(api_key=GEMINI_API_KEY, http_options={"api_version": "v1alpha"})
        
        # NATIVE AUDIO BIDIRECTIONAL: Audio in -> Audio out (with automatic transcription)
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],  # Native audio output
            system_instruction=SYSTEM_PROMPT,  # Strategic negotiation prompts
            output_audio_transcription={}   # Get text transcription of audio responses
        )
        
        print("🔗 Connecting to Gemini Live API...")
        print(f"📋 System Prompt: {SYSTEM_PROMPT[:100]}...")
        
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            print("✅ Successfully connected to Gemini Live API")
            print("🎯 Negotiation strategist mode activated")
            
            async def receive_from_client():
                nonlocal chunk_count
                try:
                    while True:
                        try:
                            message = await websocket.receive_text()
                        except WebSocketDisconnect:
                            print("👋 Client disconnected normally")
                            break
                        
                        try:
                            data = json.loads(message)
                        except json.JSONDecodeError as e:
                            print(f"❌ JSON decode error: {e}")
                            continue
                        
                        if "realtime_input" in data:
                            chunk_count += 1
                            media_chunks = data["realtime_input"].get("media_chunks", [])
                            
                            if chunk_count % 100 == 0:
                                print(f"🎤 Processing audio chunk #{chunk_count}")
                            
                            for idx, chunk in enumerate(media_chunks):
                                if "data" in chunk:
                                    try:
                                        # Decode base64 to bytes
                                        audio_bytes = base64.b64decode(chunk["data"])
                                        
                                        # Send PCM audio using send_realtime_input (new API method)
                                        await session.send_realtime_input(
                                            audio=types.Blob(
                                                data=audio_bytes,
                                                mime_type="audio/pcm;rate=16000"
                                            )
                                        )
                                        
                                    except Exception as e:
                                        print(f"  ❌ Error sending to Gemini: {e}")
                                    
                                    # Process for Volume Visualization
                                    try:
                                        b64_data = chunk["data"]
                                        audio_bytes = base64.b64decode(b64_data)
                                        audio_arr = np.frombuffer(audio_bytes, dtype=np.int16)
                                        
                                        if len(audio_arr) > 0:
                                            rms = np.sqrt(np.mean(audio_arr.astype(np.float64)**2))
                                            vol = min(100, int((rms / 5000) * 100))
                                            await websocket.send_json({"vol": vol})
                                    except Exception as e:
                                        pass  # Silent fail for volume processing
                                            
                        elif "client_content" in data:
                             # Handle text input if needed - use send_client_content
                             await session.send_client_content(
                                 turns={"role": "user", "parts": [{"text": data["client_content"].get("text", "")}]},
                                 turn_complete=True
                             )
                             print("📤 Sent client text content to Gemini")
                             
                except Exception as e:
                    print(f"❌ Error in receive_from_client: {e}")
                    import traceback
                    traceback.print_exc()

            async def send_to_client():
                response_count = 0
                try:
                    print("👂 Starting to listen for Gemini's tactical whispers...")
                    async for response in session.receive():
                        response_count += 1
                        
                        server_content = response.server_content
                        if server_content is None:
                            continue
                            
                        model_turn = server_content.model_turn
                        if model_turn:
                            for part_idx, part in enumerate(model_turn.parts):
                                # AUDIO whisper - play it back
                                if part.inline_data:
                                    data_len = len(part.inline_data.data) if hasattr(part.inline_data, 'data') else 0
                                    print(f"🔊 Audio whisper received ({data_len} bytes)")
                                    
                                    # Encode audio data to base64 for transmission
                                    audio_base64 = base64.b64encode(part.inline_data.data).decode('utf-8')
                                    
                                    await websocket.send_json({
                                        "type": "audio",
                                        "audio": audio_base64, 
                                        "mime_type": part.inline_data.mime_type
                                    })
                                
                                # TEXT transcription - display as whisper
                                if part.text:
                                    print(f"💬 WHISPER TRANSCRIPT #{response_count}: {part.text}")
                                    await websocket.send_json({
                                        "type": "whisper",
                                        "text": part.text
                                    })

                        if server_content.turn_complete:
                            print("✅ Whisper complete")
                            await websocket.send_json({"turn_complete": True})

                except Exception as e:
                    print(f"❌ Error in send_to_client: {e}")
                    import traceback
                    traceback.print_exc()

            print("🚀 Starting bidirectional audio stream + tactical analysis")
            await asyncio.gather(receive_from_client(), send_to_client())

    except Exception as e:
        print(f"❌ WebSocket connection error (Global): {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("=" * 80)
        print(f"🔌 Closing WebSocket connection (processed {chunk_count} audio chunks)")
        print("=" * 80)
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    print("\n" + "=" * 80)
    print("🎯 Starting Negotiation Strategist Backend")
    print("=" * 80)
    print(f"Model: {MODEL}")
    print(f"Mode: Real-time tactical whispers")
    print(f"WebSocket endpoint: ws://localhost:8000/ws")
    print("=" * 80 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)