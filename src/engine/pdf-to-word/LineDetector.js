// ============================================
// NOVAPDF LINE DETECTOR
// ============================================

import {
    createLine,
} from "./NovaDOC";


// ============================================
// DETECTAR LÍNEAS
// ============================================

export function detectLines(
    textItems
) {

    const lines = [];


    for (
        const item
        of textItems
    ) {

        let bestLine = null;

        let bestDistance =
            Infinity;


        /*
         * Tolerancia dinámica basada
         * en el tamaño del texto.
         */

        const tolerance =
            Math.max(
                2.5,
                item.height * 0.45
            );


        for (
            const line
            of lines
        ) {

            const distance =
                Math.abs(
                    line.y -
                    item.y
                );


            if (
                distance <= tolerance &&
                distance < bestDistance
            ) {

                bestLine = line;

                bestDistance =
                    distance;
            }
        }


        // ====================================
        // NUEVA LÍNEA
        // ====================================

        if (!bestLine) {

            bestLine =
                createLine({

                    x:
                        item.x,

                    y:
                        item.y,

                    width:
                        item.width,

                    height:
                        item.height,

                    items: [],

                });


            lines.push(
                bestLine
            );
        }


        bestLine.items.push(
            item
        );


        // ====================================
        // ACTUALIZAR GEOMETRÍA
        // ====================================

        const minX =
            Math.min(
                bestLine.x,
                item.x
            );


        const maxX =
            Math.max(
                bestLine.x +
                    bestLine.width,

                item.x +
                    item.width
            );


        bestLine.x =
            minX;


        bestLine.width =
            maxX - minX;


        bestLine.height =
            Math.max(
                bestLine.height,
                item.height
            );
    }


    // ========================================
    // ORDENAR
    // ========================================

    lines.sort(
        (a, b) => {

            const yDifference =
                Math.abs(
                    a.y - b.y
                );


            if (
                yDifference > 2
            ) {

                return b.y - a.y;
            }


            return a.x - b.x;
        }
    );


    // ========================================
    // CONSTRUIR TEXTO
    // ========================================

    for (
        const line
        of lines
    ) {

        line.items.sort(
            (a, b) =>
                a.x - b.x
        );


        let text = "";

        let previous = null;


        for (
            const item
            of line.items
        ) {

            if (previous) {

                const previousEnd =
                    previous.x +
                    previous.width;


                const gap =
                    item.x -
                    previousEnd;


                /*
                 * El espacio se determina
                 * según la distancia real.
                 */

                const spaceThreshold =
                    Math.max(
                        1.5,
                        previous.height *
                            0.12
                    );


                if (
                    gap >
                    spaceThreshold
                ) {

                    text += " ";
                }
            }


            text += item.text;


            previous =
                item;
        }


        line.text =
            text
                .replace(
                    /\s+/g,
                    " "
                )
                .trim();
    }


    return lines.filter(
        (line) =>
            line.text.length > 0
    );
}