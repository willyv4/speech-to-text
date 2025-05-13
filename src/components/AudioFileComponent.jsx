import { useState, useRef, useEffect } from 'react';

const WHISPER_SAMPLING_RATE = 16_000;
const MAX_AUDIO_LENGTH = 30; // seconds
const MAX_SAMPLES = WHISPER_SAMPLING_RATE * MAX_AUDIO_LENGTH;

const AudioFileComponent = ({ worker, language, setText }) => {
  // File upload
  const [selectedFile, setSelectedFile] = useState(null);
  const fileInputRef = useRef(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const audioRef = useRef(null);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [isProcessingFullFile, setIsProcessingFullFile] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Variables for full file processing
  const fullAudioDataRef = useRef(null);
  const currentChunkRef = useRef(0);
  const totalChunksRef = useRef(0);
  const waitingForChunkRef = useRef(false);
  const audioContextRef = useRef(null);
  
  // Initialize audio context
  useEffect(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: WHISPER_SAMPLING_RATE });
    }
    
    // Set up message listener for chunk completion
    const handleWorkerMessage = (e) => {
      if (e.data.status === 'complete' && isProcessingFullFile) {
        const newOutput = e.data.output[0].trim();
        const chunkId = e.data.chunkId;
        
        console.log(`Received completion for chunk ${chunkId}, output length: ${newOutput.length}`);
        
        if (newOutput) {
          setText(p => `${p} ${newOutput}`);
        }
        
        // Resolve the promise for this chunk
        if (window.chunkResolvers && window.chunkResolvers[chunkId]) {
          console.log(`Resolving promise for chunk ${chunkId}`);
          const resolver = window.chunkResolvers[chunkId];
          delete window.chunkResolvers[chunkId];
          resolver();
        }
      }
    };
    
    // Add worker message listener
    worker.current.addEventListener('message', handleWorkerMessage);
    
    return () => {
      // Clean up when component unmounts
      worker.current.removeEventListener('message', handleWorkerMessage);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      window.chunkResolvers = null;
    };
  }, [worker, isProcessingFullFile, setText]);
  
  // Create audio URL when file is selected
  useEffect(() => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    
    if (selectedFile) {
      const url = URL.createObjectURL(selectedFile);
      setAudioUrl(url);
    }
    
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [selectedFile]);
  
  // Monitor audio playback state
  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) return;
    
    const handlePlay = () => {};
    const handlePause = () => {};
    const handleEnded = () => {};
    
    audioElement.addEventListener('play', handlePlay);
    audioElement.addEventListener('pause', handlePause);
    audioElement.addEventListener('ended', handleEnded);
    
    return () => {
      audioElement.removeEventListener('play', handlePlay);
      audioElement.removeEventListener('pause', handlePause);
      audioElement.removeEventListener('ended', handleEnded);
    };
  }, []);
  
  const handleFileChange = (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      console.log('File selected:', file.name);
      
      // First set the file
      setSelectedFile(file);
      
      // Reset all processing state
      setText('');
      setProcessingProgress(0);
      setIsProcessing(false);
      setIsProcessingFullFile(false);
      waitingForChunkRef.current = false;
      currentChunkRef.current = 0;
      totalChunksRef.current = 0;
      
      // Process immediately
      processAudioFileWithFile(file);
    }
  };
  
  // Process a specific file directly
  const processAudioFileWithFile = async (file) => {
    console.log('Starting to process audio file:', file.name);
    setProcessingProgress(0);
    setIsProcessingFullFile(true);
    waitingForChunkRef.current = false;
    currentChunkRef.current = 0;
    totalChunksRef.current = 0;
    setText(''); // Clear text before processing
    
    const fileReader = new FileReader();
    
    fileReader.onloadend = async () => {
      try {
        const arrayBuffer = fileReader.result;
        const decoded = await audioContextRef.current.decodeAudioData(arrayBuffer);
        const audio = decoded.getChannelData(0);
        
        console.log(`Total audio length: ${audio.length} samples (${audio.length/WHISPER_SAMPLING_RATE} seconds)`);
        
        // Store the full audio data for processing
        fullAudioDataRef.current = audio;
        
        // Calculate total chunks needed
        const totalChunks = Math.ceil(audio.length / MAX_SAMPLES);
        totalChunksRef.current = totalChunks;
        
        console.log(`Processing in ${totalChunks} chunks of ${MAX_SAMPLES} samples each`);
        
        // Start processing all chunks
        processChunks(audio, totalChunks);
      } catch (error) {
        console.error("Error processing audio file:", error);
        setIsProcessing(false);
        setIsProcessingFullFile(false);
        waitingForChunkRef.current = false;
      }
    };
    
    fileReader.onerror = () => {
      setIsProcessing(false);
      setIsProcessingFullFile(false);
      waitingForChunkRef.current = false;
    };
    
    fileReader.readAsArrayBuffer(file);
  };
  
  // Process all chunks with parallelism
  const processChunks = async (audio, totalChunks) => {
    currentChunkRef.current = 0;
    
    // Maximum chunks to process in parallel
    const MAX_PARALLEL_CHUNKS = 3;
    
    // Process chunks in batches
    for (let i = 0; i < totalChunks; i += MAX_PARALLEL_CHUNKS) {
      // Calculate how many chunks we can process in this batch
      const batchSize = Math.min(MAX_PARALLEL_CHUNKS, totalChunks - i);
      console.log(`Processing batch of ${batchSize} chunks starting at index ${i}`);
      
      const chunkPromises = [];
      
      // Create promises for each chunk in the batch
      for (let j = 0; j < batchSize; j++) {
        const chunkIndex = i + j;
        const startSample = chunkIndex * MAX_SAMPLES;
        const endSample = Math.min(startSample + MAX_SAMPLES, audio.length);
        const audioChunk = audio.slice(startSample, endSample);
        
        // Update progress based on completed chunks
        const progress = Math.round((i + j) / totalChunks * 100);
        setProcessingProgress(progress);
        
        // Create a promise for this chunk
        const chunkPromise = new Promise((resolve) => {
          console.log(`Sending chunk ${chunkIndex} for processing`);
          
          // Store the resolve function in an array indexed by chunkId
          if (!window.chunkResolvers) window.chunkResolvers = {};
          window.chunkResolvers[chunkIndex] = resolve;
          
          // Send the chunk to the worker
          worker.current.postMessage({ 
            type: 'generate', 
            data: { 
              audio: audioChunk, 
              language,
              chunkId: chunkIndex 
            } 
          });
          
          // No timeout needed as we're now using the worker message to resolve
        });
        
        chunkPromises.push(chunkPromise);
      }
      
      // Wait for all chunks in this batch to complete
      await Promise.all(chunkPromises);
      console.log(`Completed batch starting at index ${i}`);
    }
    
    console.log('Finished processing all chunks');
    setIsProcessingFullFile(false);
    setIsProcessing(false);
    setProcessingProgress(100);
  };
  
  return (
    <div className="mt-4 w-full max-w-[500px] flex flex-col items-center">
      <div className="w-full mb-4">
        {audioUrl && (
          <audio 
            ref={audioRef}
            src={audioUrl} 
            className="w-full mb-2" 
            controls
          />
        )}
      </div>
      <div className="flex w-full justify-center gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="audio/*"
          className="border rounded px-2 py-1 w-3/4"
          disabled={isProcessing || isProcessingFullFile}
        />
        <button
          onClick={() => selectedFile && processAudioFileWithFile(selectedFile)}
          className="border px-4 py-1 rounded-lg bg-blue-400 text-white hover:bg-blue-500 disabled:bg-blue-100 disabled:cursor-not-allowed"
          disabled={!selectedFile || isProcessing || isProcessingFullFile}
        >
          {isProcessing ? "Processing..." : "Process"}
        </button>
      </div>
      {selectedFile && <p className="text-sm mt-1">Selected: {selectedFile.name}</p>}
      {(isProcessing || isProcessingFullFile) && (
        <div className="w-full mt-2">
          <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
            <div 
              className="bg-blue-400 h-2.5 rounded-full" 
              style={{ width: `${processingProgress}%` }}
            ></div>
          </div>
          <p className="text-sm text-center mt-1">
            {isProcessingFullFile ? `Processing: ${processingProgress}%` : 'Processing...'}
          </p>
        </div>
      )}
    </div>
  );
};

export default AudioFileComponent; 