import assert from "node:assert/strict";
import test from "node:test";

import {
    analyzePage,
} from "../src/engine/layout/PageAnalyzer.js";


function createLine(
    row,
    xPositions
) {

    const words =
        xPositions.map(
            (
                x,
                column
            ) => ({

                text:
                    `R${row}C${column}`,

                x,

                y:
                    100 + row * 25,

                width: 50,

                height: 12,

                confidence: 95,

            })
        );


    return {

        text:
            words
                .map(
                    word =>
                        word.text
                )
                .join(" "),

        words,

    };

}


test(
    "conserva todas las filas de una tabla genérica alineada",
    () => {

        const lines =
            Array.from(
                {
                    length: 8,
                },
                (
                    _,
                    row
                ) =>
                    createLine(
                        row,
                        [
                            100,
                            300,
                            500,
                            700,
                        ]
                    )
            );


        const result =
            analyzePage({

                pageNumber: 1,

                width: 1000,

                height: 1000,

                words:
                    lines.flatMap(
                        line =>
                            line.words
                    ),

                lines,

            });


        assert.equal(
            result.tables.length,
            1
        );

        assert.equal(
            result.tables[0].lineCount,
            8
        );

        assert.equal(
            result.tables[0].rows.length,
            8
        );

        assert.equal(
            result.paragraphs.length,
            0
        );

    }
);


test(
    "expone por separado los bloques OCR y los bloques semánticos",
    () => {

        const lines = [
            createLine(
                0,
                [
                    100,
                ]
            ),
            createLine(
                1,
                [
                    100,
                ]
            ),
        ];


        const sourceBlocks = [
            {
                text:
                    "Bloque original OCR",
            },
        ];


        const sourceParagraphs = [
            {
                text:
                    "Párrafo original OCR",
            },
        ];


        const result =
            analyzePage({

                pageNumber: 1,

                width: 1000,

                height: 1000,

                words:
                    lines.flatMap(
                        line =>
                            line.words
                    ),

                lines,

                blocks:
                    sourceBlocks,

                paragraphs:
                    sourceParagraphs,

            });


        assert.deepEqual(
            result.sourceBlocks,
            sourceBlocks
        );

        assert.deepEqual(
            result.sourceParagraphs,
            sourceParagraphs
        );

        assert.equal(
            result.blocks.length,
            1
        );

        assert.equal(
            typeof result.blocks[0].role,
            "string"
        );

    }
);
