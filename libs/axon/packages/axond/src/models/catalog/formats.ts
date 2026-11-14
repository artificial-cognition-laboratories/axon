export const RUNNABLE = [".onnx", ".gguf", ".safetensors", ".pt", ".pth"]

/** `model-00001-of-00004.safetensors` and friends — parts, not alternatives. */
export const SHARD = /-\d{2,5}-of-\d{2,5}\./
