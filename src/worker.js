import {
    AutoTokenizer,
    AutoProcessor,
    WhisperForConditionalGeneration,
    TextStreamer,
    full,
} from '@huggingface/transformers';


const MAX_NEW_TOKENS = 128;

/**
 * This class uses the Singleton pattern to ensure that only one instance of the model is loaded.
 */
class AutomaticSpeechRecognitionPipeline {
    static model_id = null;
    static tokenizer = null;
    static processor = null;
    static model = null;

    static async getInstance(progress_callback = null) {
        this.model_id = 'onnx-community/whisper-base';

        this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, {
            progress_callback,
        });
        this.processor ??= AutoProcessor.from_pretrained(this.model_id, {
            progress_callback,
        });

        this.model ??= WhisperForConditionalGeneration.from_pretrained(this.model_id, {
            dtype: {
                encoder_model: 'fp32', // 'fp16' works too
                decoder_model_merged: 'q4', // or 'fp32' ('fp16' is broken)
            },
            device: 'webgpu',
            progress_callback,
        });

        return Promise.all([this.tokenizer, this.processor, this.model]);
    }
}

// Simple processing flag
let isCurrentlyProcessing = false;
let lastProcessedChunkId = -1;
let processingQueue = [];

async function generate({ audio, language, chunkId }) {
    console.log(`Worker received request for chunk ${chunkId}, length: ${audio.length} samples`);
    
    // If we're already processing, queue the request rather than immediately rejecting
    if (isCurrentlyProcessing) {
        console.log(`Already processing, queueing chunk ${chunkId} for later`);
        
        // If this chunk has already been processed or is in the queue, skip it
        if (chunkId <= lastProcessedChunkId || processingQueue.some(item => item.chunkId === chunkId)) {
            console.log(`Chunk ${chunkId} already processed or queued, skipping`);
            return;
        }
        
        // Add to processing queue - will be processed after current chunk completes
        processingQueue.push({ audio, language, chunkId });
        return;
    }
    
    try {
        isCurrentlyProcessing = true;
        lastProcessedChunkId = chunkId;
        console.log(`Worker: Starting processing chunk ${chunkId}`);
        
        // Tell the main thread we are starting
        self.postMessage({ status: 'start', chunkId });

        // Retrieve the text-generation pipeline.
        const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance();

        let startTime;
        let numTokens = 0;
        const callback_function = (output) => {
            startTime ??= performance.now();

            let tps;
            if (numTokens++ > 0) {
                tps = numTokens / (performance.now() - startTime) * 1000;
            }
            self.postMessage({
                status: 'update',
                output, tps, numTokens,
                chunkId
            });
        }

        const streamer = new TextStreamer(tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function,
        });

        const inputs = await processor(audio);

        const outputs = await model.generate({
            ...inputs,
            max_new_tokens: MAX_NEW_TOKENS,
            language,
            streamer,
            do_sample: false,
        });

        const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true });

        console.log(`Worker: Completed processing chunk ${chunkId}`);
        
        // Send the output back to the main thread
        self.postMessage({
            status: 'complete',
            output: outputText,
            chunkId,
        });
    } catch (error) {
        console.error(`Error in generate for chunk ${chunkId}:`, error);
        self.postMessage({
            status: 'error',
            data: `Error processing audio segment ${chunkId}: ${error.toString()}`,
            chunkId,
        });
    } finally {
        isCurrentlyProcessing = false;
        
        // Process next item in queue if available
        if (processingQueue.length > 0) {
            const nextItem = processingQueue.shift();
            console.log(`Processing next chunk from queue: ${nextItem.chunkId}`);
            setTimeout(() => generate(nextItem), 0); // Use setTimeout to avoid stack overflow
        }
    }
}

async function load() {
    self.postMessage({
        status: 'loading',
        data: 'Loading model...'
    });

    try {
        // Load the pipeline and save it for future use.
        const [, , model] = await AutomaticSpeechRecognitionPipeline.getInstance(x => {
            // We also add a progress callback to the pipeline so that we can
            // track model loading.
            self.postMessage(x);
        });

        self.postMessage({
            status: 'loading',
            data: 'Compiling shaders and warming up model...'
        });

        // Run model with dummy input to compile shaders
        await model.generate({
            input_features: full([1, 80, 3000], 0.0),
            max_new_tokens: 1,
        });
        self.postMessage({ status: 'ready' });
    } catch (error) {
        console.error("Error loading model:", error);
        self.postMessage({ 
            status: 'error', 
            data: 'Error loading model: ' + error.toString() 
        });
    }
}

// Listen for messages from the main thread
self.addEventListener('message', async (e) => {
    const { type, data } = e.data;

    switch (type) {
        case 'load':
            load();
            break;

        case 'generate':
            generate(data);
            break;
    }
});
