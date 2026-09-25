export default defineCognet({
    mode: { kind: "continuous" },

    // models: {
    //     asr: {
    //         hf: "onnx-community/whisper-tiny.en",
    //         set: true,
    //         capability: "speech",
    //         type: "transform",
    //         in: ["audio"],
    //         out: ["text"],
    //     },
    // },

    engines: {
        main: {
            type: "generate",
            in: "text",
            out: "text",
            context: 32_000,
            primary: true,
        },

        asr: {
            type: "transform",
            in: "audio",
            out: "text",
            optional: false,
        },

        tts: {
            type: "generate",
            in: "text",
            out: "audio",
            optional: false,
        },
    },
})
