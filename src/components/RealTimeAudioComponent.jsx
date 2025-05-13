import { useState, useEffect, useRef } from 'react';
import { AudioVisualizer } from './AudioVisualizer';

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30; // seconds
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;

const RealTimeAudioComponent = ({ worker, status, language, setText }) => {
  const [recording, setRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [chunks, setChunks] = useState([]);
  const [stream, setStream] = useState(null);
  const recorderRef = useRef(null);
  const audioContextRef = useRef(null);
  
  // Initialize audio context
  useEffect(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: WHISPER_SAMPLING_RATE });
    }
    
    return () => {
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, []);
  
  // Setup microphone
  useEffect(() => {
    if (recorderRef.current) return;

    const setupMicrophone = async () => {
      if (navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          setStream(stream);

          recorderRef.current = new MediaRecorder(stream);

          recorderRef.current.onstart = () => {
            setRecording(true);
            setChunks([]);
          };
          
          recorderRef.current.ondataavailable = (e) => {
            if (e.data.size > 0) {
              setChunks((prev) => [...prev, e.data]);
            } else {
              // Empty chunk received, so we request new data after a short timeout
              setTimeout(() => {
                if (recorderRef.current && recorderRef.current.state === 'recording') {
                  recorderRef.current.requestData();
                }
              }, 25);
            }
          };

          recorderRef.current.onstop = () => {
            setRecording(false);
          };

          if (status === 'ready') {
            startRecording();
          }
        } catch (err) {
          console.error("The following error occurred: ", err);
        }
      } else {
        console.error("getUserMedia not supported on your browser!");
      }
    };
    
    setupMicrophone();

    return () => {
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }
      
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [status]);
  
  // Process real-time audio chunks
  useEffect(() => {
    if (!recorderRef.current) return;
    if (!recording) return;
    if (isProcessing) return;
    if (status !== 'ready') return;

    if (chunks.length > 0) {
      // Generate from data
      const blob = new Blob(chunks, { type: recorderRef.current.mimeType });

      const fileReader = new FileReader();

      fileReader.onloadend = async () => {
        const arrayBuffer = fileReader.result;
        const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer);
        let audio = decoded.getChannelData(0);
        if (audio.length > MAX_SAMPLES) { // Get last MAX_SAMPLES
          audio = audio.slice(-MAX_SAMPLES);
        }

        worker.current.postMessage({ 
          type: 'generate', 
          data: { 
            audio, 
            language,
            chunkId: 'realtime' // Add chunkId for realtime processing
          } 
        });
      }
      fileReader.readAsArrayBuffer(blob);
    } else {
      recorderRef.current?.requestData();
    }
  }, [recording, isProcessing, chunks, language, status, worker]);
  
  // Update processing state and handle text updates when worker sends messages
  useEffect(() => {
    const handleWorkerMessage = (e) => {
      if (e.data.status === 'start' && e.data.chunkId === 'realtime') {
        setIsProcessing(true);
      } else if (e.data.status === 'complete' && e.data.chunkId === 'realtime') {
        setIsProcessing(false);
        
        // Handle text updates here
        const output = e.data.output[0].trim();
        if (output && output !== '[BLANK_AUDIO]') {
          setText(p => {
            // Only append if not blank or duplicate
            const trimmed = p.trim();
            if (!trimmed) return output;
            // Check if this output is already part of the existing text
            if (!trimmed.endsWith(output) && output !== '[BLANK_AUDIO]') {
              return `${trimmed} ${output}`;
            }
            return trimmed;
          });
        }
      }
    };
    
    worker.current.addEventListener('message', handleWorkerMessage);
    
    return () => {
      worker.current.removeEventListener('message', handleWorkerMessage);
    };
  }, [worker, setText]);
  
  const startRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'recording') {
      recorderRef.current.start();
      setRecording(true);
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
      setRecording(false);
    }
  };
  
  const resetRecording = () => {
    stopRecording();
    setText(''); // Clear text on reset
    startRecording();
  };

  return (
    <div className="w-full flex flex-col items-center">
      <AudioVisualizer className="w-full rounded-lg" stream={stream} />
      <div className="mt-4 flex justify-center gap-4">
        <button 
          className="border px-4 py-2 rounded-lg bg-blue-400 text-white hover:bg-blue-500"
          onClick={resetRecording}
          disabled={status !== 'ready'}
        >
          Reset
        </button>
        {!recording ? (
          <button 
            className="border px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600"
            onClick={startRecording}
            disabled={status !== 'ready'}
          >
            Start Recording
          </button>
        ) : (
          <button 
            className="border px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600"
            onClick={stopRecording}
          >
            Stop Recording
          </button>
        )}
      </div>
    </div>
  );
};

export default RealTimeAudioComponent; 