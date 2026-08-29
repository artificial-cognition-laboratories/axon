import { describe, expect, test } from "bun:test";
import { arcnight, palette } from "../src/index";

describe("@arcforge/theme public exports", () => {
    test("provides the Arcnight dark Shiki theme contract", () => {
        expect(arcnight.name).toBe("arcnight");
        expect(arcnight.type).toBe("dark");
        expect(arcnight.colors).toEqual({
            "editor.background": "#070b10",
            "editor.foreground": "#c7eaff",
        });
        expect(arcnight.tokenColors).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    scope: expect.arrayContaining(["variable", "meta.object-literal.key"]),
                    settings: { foreground: "#7cceff" },
                }),
                expect.objectContaining({
                    scope: ["comment", "comment.line", "comment.block"],
                    settings: { foreground: "#585858", fontStyle: "italic" },
                }),
                expect.objectContaining({
                    scope: ["entity.name.tag.execute.air"],
                    settings: { foreground: "#00B4D8" },
                }),
            ]),
        );
    });

    test("provides the Axon UI palette contract", () => {
        expect(palette).toEqual({
            primary: "#00B4D8",
            userText: "#c8c8c8",
            agentText: "#d2d2d2",
            thinkingText: "#646464",
            thinkingGlyph: "#3c3c3c",
            toolLabel: "#828282",
            output: "#505050",
            railDim: "#3c3c3c",
            railBright: "#505050",
            omitted: "#3c3c3c",
            error: "#b43c3c",
            errorBright: "#f14c4c",
            waiting: "#a07828",
            denied: "#a03c3c",
            codeLine: "#3c3c3c",
        });
    });
});
