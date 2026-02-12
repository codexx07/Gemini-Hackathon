import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './App.css';

function App() {
  const [isNegotiating, setIsNegotiating] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [whispers, setWhispers] = useState([]);
  const [debugInfo, setDebugInfo] = useState({ status: 'Disconnected', lastMessage: '' });

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const processorRef = useRef(null);
  const whisperIdCounter = useRef(0);

  useEffect(() => {
    if (isNegotiating) {
      connectWebSocket();
    } else {
      disconnectWebSocket();
    }
    return () => disconnectWebSocket();
  }, [isNegotiating]);

  const connectWebSocket = () => {
    console.log('[WS] Connecting to ws://localhost:8000/ws');
    setDebugInfo(prev => ({ ...prev, status: 'Connecting...' }));
    setWhispers([]); // Clear old whispers

    wsRef.current = new WebSocket('ws://localhost:8000/ws');

    wsRef.current.onopen = () => {
      console.log('[WS] ✅ Connected to Backend');
      setDebugInfo(prev => ({ ...prev, status: 'Connected' }));
      setIsConnected(true);

      setTimeout(() => {
        startAudioCapture();
      }, 100);
    };

    wsRef.current.onmessage = async (event) => {
      const msgPreview = event.data.length > 50 ? event.data.substring(0, 50) + "..." : event.data;
      setDebugInfo(prev => ({ ...prev, lastMessage: msgPreview }));

      try {
        const data = JSON.parse(event.data);

        // Volume level for visualization
        if (data.vol !== undefined) {
          setAudioLevel(data.vol);
        }

        // TEXT whisper from Gemini
        if (data.type === "whisper" && data.text) {
          console.log('[WHISPER]', data.text);

          const newWhisper = {
            id: whisperIdCounter.current++,
            text: data.text,
            timestamp: Date.now()
          };

          setWhispers(prev => [...prev, newWhisper]);

          // Auto-remove after 10 seconds
          setTimeout(() => {
            setWhispers(prev => prev.filter(w => w.id !== newWhisper.id));
          }, 10000);
        }

        // AUDIO whisper from Gemini
        if (data.type === "audio" && data.audio) {
          console.log('[WS] Playing audio whisper');
          playPcmChunk(data.audio);
        }

        // Legacy support
        if (data.audio && !data.type) {
          playPcmChunk(data.audio);
        }

        if (data.text && !data.type) {
          console.log('[WS] Gemini:', data.text);
        }
      } catch (e) {
        console.error('[WS] Error parsing message:', e);
      }
    };

    wsRef.current.onerror = (error) => {
      console.error('[WS] ❌ WebSocket error:', error);
      setDebugInfo(prev => ({ ...prev, status: 'Error' }));
    };

    wsRef.current.onclose = (event) => {
      console.log('[WS] Disconnected', event.code, event.reason);
      setDebugInfo(prev => ({ ...prev, status: `Disconnected (${event.code})` }));
      setIsConnected(false);
      stopAudioCapture();
    };
  };

  const disconnectWebSocket = () => {
    if (wsRef.current) {
      console.log('[WS] Closing connection');
      wsRef.current.close();
      wsRef.current = null;
    }
    stopAudioCapture();
    setIsConnected(false);
    setAudioLevel(0);
    setWhispers([]);
    setDebugInfo({ status: 'Disconnected', lastMessage: '' });
  };

  const startAudioCapture = async () => {
    try {
      console.log('[AUDIO] Requesting microphone access...');

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia is not supported in this browser");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 16000 }
        }
      });

      console.log('[AUDIO] ✅ Microphone access granted');
      mediaStreamRef.current = stream;

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });

      console.log('[AUDIO] AudioContext state:', audioContextRef.current.state);

      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
        console.log('[AUDIO] AudioContext resumed');
      }

      const source = audioContextRef.current.createMediaStreamSource(stream);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);

        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64Data = btoa(
          String.fromCharCode(...new Uint8Array(pcmData.buffer))
        );

        try {
          wsRef.current.send(JSON.stringify({
            realtime_input: {
              media_chunks: [{
                mime_type: "audio/pcm",
                data: base64Data
              }]
            }
          }));
        } catch (err) {
          console.error('[AUDIO] Error sending audio:', err);
        }
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
      console.log('[AUDIO] ✅ Audio pipeline connected');

    } catch (err) {
      console.error('[AUDIO] ❌ Error:', err);
      setDebugInfo(prev => ({ ...prev, lastMessage: `Mic Error: ${err.message}` }));
      setIsConnected(false);
      setTimeout(() => setIsNegotiating(false), 2000);
    }
  };

  const stopAudioCapture = () => {
    console.log('[AUDIO] Stopping audio capture');

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const playPcmChunk = (base64Audio) => {
    try {
      const audioBytes = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0)).buffer;
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

      const float32Data = new Float32Array(audioBytes.byteLength / 2);
      const dataView = new DataView(audioBytes);

      for (let i = 0; i < float32Data.length; i++) {
        const int16 = dataView.getInt16(i * 2, true);
        float32Data[i] = int16 / 32768.0;
      }

      const buffer = ctx.createBuffer(1, float32Data.length, 24000);
      buffer.copyToChannel(float32Data, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      console.error('[AUDIO] Error playing audio:', err);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center overflow-hidden relative">
      <AnimatePresence mode="wait">
        {!isNegotiating ? (
          <motion.button
            key="start-btn"
            layoutId="negotiation-trigger"
            onClick={() => setIsNegotiating(true)}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.3 } }}
            whileHover={{ scale: 1.05, backgroundColor: "rgba(255, 255, 255, 0.15)" }}
            whileTap={{ scale: 0.95 }}
            className="px-12 py-6 rounded-full text-white text-xl font-medium tracking-wide
                       bg-white/10 backdrop-blur-md border border-white/20 shadow-[0_0_30px_rgba(255,255,255,0.1)]
                       transition-all duration-300"
          >
            Start Negotiation
          </motion.button>
        ) : (
          <motion.div
            key="waves"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex items-center justify-center p-20"
          >
            {/* Core center */}
            <div className={`w-4 h-4 rounded-full z-10 shadow-[0_0_20px_rgba(255,255,255,0.8)] transition-colors duration-500 ${isConnected ? 'bg-white' : 'bg-red-500'}`} />

            {/* Concentric Rings */}
            {[0, 1, 2].map((index) => (
              <motion.div
                key={index}
                className="absolute border border-white/20 rounded-full"
                animate={{
                  scale: 1 + (audioLevel / 100) * (0.4 + index * 0.2),
                  opacity: (audioLevel / 100) * (0.8 - index * 0.2),
                  borderWidth: (audioLevel / 100) * 3 + "px"
                }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 20
                }}
                style={{
                  width: `${120 + index * 60}px`,
                  height: `${120 + index * 60}px`,
                }}
              />
            ))}

            {/* Status Text */}
            <motion.p
              className="absolute -bottom-24 text-white/50 text-sm tracking-widest uppercase"
              animate={{ opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              {isConnected ? "Listening..." : "Connecting..."}
            </motion.p>

            {/* End Button */}
            <motion.button
              onClick={() => setIsNegotiating(false)}
              className="absolute -bottom-44 px-8 py-3 rounded-full bg-red-500/20 text-red-200 
                         border border-red-500/30 hover:bg-red-500/30 transition-all 
                         text-xs tracking-widest uppercase backdrop-blur-md shadow-lg shadow-red-900/10"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              End Session
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Whispers Display */}
      <div className="fixed top-0 left-0 right-0 p-6 pointer-events-none z-40">
        <AnimatePresence>
          {whispers.map((whisper, index) => (
            <motion.div
              key={whisper.id}
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.9 }}
              transition={{ duration: 0.3 }}
              className="mb-3 mx-auto max-w-2xl"
              style={{ marginTop: index * 10 }}
            >
              <div className="bg-gradient-to-r from-purple-900/90 to-blue-900/90 backdrop-blur-md 
                            border border-purple-500/30 rounded-lg p-4 shadow-2xl shadow-purple-900/50">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-2 h-2 rounded-full bg-purple-400 mt-2 animate-pulse" />
                  <p className="text-white text-base font-medium leading-relaxed">
                    {whisper.text}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Debug Panel */}
      <div className="fixed bottom-0 left-0 w-full bg-black/90 text-green-400 p-2 font-mono text-xs border-t border-green-900 overflow-hidden whitespace-nowrap z-50">
        <span className="font-bold">DEBUG:</span> Status: <span className={isConnected ? "text-green-400" : "text-red-400"}>{debugInfo.status}</span> | Last Msg: {debugInfo.lastMessage} | Whispers: {whispers.length}
      </div>
    </div>
  );
}

export default App;