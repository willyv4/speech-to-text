import { useEffect, useState, useRef } from 'react';

import Progress from './components/Progress';
import { LanguageSelector } from './components/LanguageSelector';
import AudioFileComponent from './components/AudioFileComponent';
import RealTimeAudioComponent from './components/RealTimeAudioComponent';

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

function App() {

  // Create a reference to the worker object.
  const worker = useRef(null);

  // Model loading and progress
  const [status, setStatus] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [progressItems, setProgressItems] = useState([]);

  // Inputs and outputs
  const [text, setText] = useState('');
  const [tps, setTps] = useState(null);
  const [language, setLanguage] = useState('en');
  
  // Mode selection
  const [mode, setMode] = useState('realtime'); // 'realtime' or 'file'

  // We use the `useEffect` hook to setup the worker as soon as the `App` component is mounted.
  useEffect(() => {
    if (!worker.current) {
      // Create the worker if it does not yet exist.
      worker.current = new Worker(new URL('./worker.js', import.meta.url), {
        type: 'module'
      });
    }

    // Create a callback function for messages from the worker thread.
    const onMessageReceived = (e) => {
      console.log("Received worker message:", e.data.status, e.data);
      
      // Declare variables used in switch cases
      let errorChunkId, resolver;
      
      switch (e.data.status) {
        case 'loading':
          // Model file start load: add a new progress item to the list.
          setStatus('loading');
          setLoadingMessage(e.data.data);
          break;

        case 'initiate':
          setProgressItems(prev => [...prev, e.data]);
          break;

        case 'progress':
          // Model file progress: update one of the progress items.
          setProgressItems(
            prev => prev.map(item => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data }
              }
              return item;
            })
          );
          break;

        case 'done':
          // Model file loaded: remove the progress item from the list.
          setProgressItems(
            prev => prev.filter(item => item.file !== e.data.file)
          );
          break;

        case 'ready':
          // Pipeline ready: the worker is ready to accept messages.
          setStatus('ready');
          break;
          
        case 'error':
          // Handle errors
          setStatus('error');
          setText(`Error: ${e.data.data}`);
          
          // Resolve any pending chunk promises
          errorChunkId = e.data.chunkId;
          if (window.chunkResolvers && window.chunkResolvers[errorChunkId]) {
            console.log(`Error occurred, resolving chunk ${errorChunkId}`);
            resolver = window.chunkResolvers[errorChunkId];
            delete window.chunkResolvers[errorChunkId];
            resolver();
          }
          break;

        case 'start': {
          // Start generation
        }
          break;

        case 'update': {
          // Generation update: update the output text.
          const { tps } = e.data;
          setTps(tps);
        }
          break;

        case 'complete':
          // The components will handle their own text updates
          break;
      }
    };

    // Attach the callback function as an event listener.
    worker.current.addEventListener('message', onMessageReceived);

    // Define a cleanup function for when the component is unmounted.
    return () => {
      worker.current.removeEventListener('message', onMessageReceived);
      // Clean up any pending resolvers
      window.chunkResolvers = null;
    };
  }, [mode]);

  const switchMode = (newMode) => {
    if (newMode === mode) return;
    
    // Reset state
    setText('');
    setTps(null);
    
    // Set new mode
    setMode(newMode);
  };

  return (
    IS_WEBGPU_AVAILABLE
      ? (<div className="flex flex-col h-screen mx-auto justify-end text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900">
        {(
          <div className="h-full overflow-auto scrollbar-thin flex justify-center items-center flex-col relative">
            <div className="flex flex-col items-center mb-1 max-w-[400px] text-center">
              <img src="logo.png" width="50%" height="auto" className="block"></img>
              <h1 className="text-4xl font-bold mb-1">Whisper WebGPU</h1>
              <h2 className="text-xl font-semibold">In-browser speech recognition</h2>
            </div>

            <div className="flex flex-col items-center px-4">
              {status === null && (<>
                <p className="max-w-[480px] mb-4">
                  <br />
                  You are about to load <a href="https://huggingface.co/onnx-community/whisper-base" target="_blank" rel="noreferrer" className="font-medium underline">whisper-base</a>,
                  a 73 million parameter speech recognition model that is optimized for inference on the web. Once downloaded, the model (~200&nbsp;MB) will be cached and reused when you revisit the page.<br />
                  <br />
                  Everything runs directly in your browser using <a href="https://huggingface.co/docs/transformers.js" target="_blank" rel="noreferrer" className="underline">🤗&nbsp;Transformers.js</a> and ONNX Runtime Web,
                  meaning no data is sent to a server. You can even disconnect from the internet after the model has loaded!
                </p>

                <button
                  className="border px-4 py-2 rounded-lg bg-blue-400 text-white hover:bg-blue-500 disabled:bg-blue-100 disabled:cursor-not-allowed select-none"
                  onClick={() => {
                    worker.current.postMessage({ type: 'load' });
                    setStatus('loading');
                  }}
                  disabled={status !== null}
                >
                  Load model
                </button>
              </>)}

              {status === 'ready' && (
                <div className="w-full max-w-[500px] mb-4">
                  <div className="flex justify-center gap-2 mb-4">
                    <button 
                      className={`px-4 py-2 rounded-lg ${mode === 'realtime' ? 'bg-blue-400 text-white' : 'border'}`}
                      onClick={() => switchMode('realtime')}
                    >
                      Real-time Audio
                    </button>
                    <button 
                      className={`px-4 py-2 rounded-lg ${mode === 'file' ? 'bg-blue-400 text-white' : 'border'}`}
                      onClick={() => switchMode('file')}
                    >
                      Audio File
                    </button>
                  </div>
                </div>
              )}

              <div className="w-[500px] p-2">
                {status === 'ready' && mode === 'realtime' && <RealTimeAudioComponent worker={worker} status={status} language={language} setText={setText} />}
                {status === 'ready' && mode === 'file' && <AudioFileComponent worker={worker} language={language} setText={setText} />}
                {status === 'ready' && <div className="relative">
                  <p className="w-full h-36 overflow-y-auto overflow-wrap-anywhere border rounded-lg p-2">{text}</p>
                  {tps && <span className="absolute bottom-0 right-0 px-1">{tps.toFixed(2)} tok/s</span>}
                </div>}
              </div>

              {status === 'ready' && (
                <>
                  <div className='relative w-full flex justify-center'>
                <LanguageSelector language={language} setLanguage={(e) => {
                  setLanguage(e);
                      if (mode === 'realtime') {
                        // Reset recording on language change
                        setText('');
                      }
                    }} />
                  </div>
                </>
              )}
              
              {status === 'loading' && (
                <div className="w-full max-w-[500px] text-left mx-auto p-4">
                  <p className="text-center">{loadingMessage}</p>
                  {progressItems.map(({ file, progress, total }, i) => (
                    <Progress key={i} text={file} percentage={progress} total={total} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>)
      : (<div className="fixed w-screen h-screen bg-black z-10 bg-opacity-[92%] text-white text-2xl font-semibold flex justify-center items-center text-center">WebGPU is not supported<br />by this browser :&#40;</div>)
  )
}

export default App
