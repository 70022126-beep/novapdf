// ============================================
// NOVAPDF BLOCK DETECTOR
// ============================================

import {
    createBlock,
} from "./NovaDOC";


// ============================================
// DETECTAR BLOQUES
// ============================================

export function detectBlocks(
    lines
) {

    if (!lines.length) {
        return [];
    }


    const blocks = [];


    for (
        const line
        of lines
    ) {

        let previousBlock =
            blocks[
                blocks.length - 1
            ];


        // ====================================
        // PRIMER BLOQUE
        // ====================================

        if (!previousBlock) {

            blocks.push(

                createBlock({

                    type:
                        "paragraph",

                    x:
                        line.x,

                    y:
                        line.y,

                    width:
                        line.width,

                    height:
                        line.height,

                    lines: [
                        line,
                    ],

                })

            );

            continue;
        }


        const previousLine =
            previousBlock.lines[
                previousBlock.lines.length - 1
            ];


        const verticalGap =
            Math.abs(
                previousLine.y -
                line.y
            );


        const averageHeight =
            (
                previousLine.height +
                line.height
            ) / 2;


        /*
         * Si la distancia vertical es
         * razonable, pertenecen al mismo
         * bloque.
         */

        const sameBlock =
            verticalGap <=
            averageHeight * 1.8;


        // ====================================
        // MISMO BLOQUE
        // ====================================

        if (sameBlock) {

            previousBlock.lines.push(
                line
            );


            const minX =
                Math.min(
                    previousBlock.x,
                    line.x
                );


            const maxX =
                Math.max(
                    previousBlock.x +
                        previousBlock.width,

                    line.x +
                        line.width
                );


            previousBlock.x =
                minX;


            previousBlock.width =
                maxX - minX;


            previousBlock.height =
                Math.abs(
                    previousBlock.y -
                    line.y
                ) +
                line.height;

        }


        // ====================================
        // NUEVO BLOQUE
        // ====================================

        else {

            blocks.push(

                createBlock({

                    type:
                        "paragraph",

                    x:
                        line.x,

                    y:
                        line.y,

                    width:
                        line.width,

                    height:
                        line.height,

                    lines: [
                        line,
                    ],

                })

            );
        }
    }


    return blocks;
}