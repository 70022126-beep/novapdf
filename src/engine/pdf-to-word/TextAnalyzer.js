// ============================================
// NOVAPDF TEXT ANALYZER
// ============================================

export function analyzeTextItems(
    textItems
) {

    return textItems

        .filter(
            (item) =>
                item.str &&
                item.str.trim()
        )

        .map((item) => {

            const transform =
                item.transform || [];


            const x =
                Number(
                    transform[4]
                ) || 0;


            const y =
                Number(
                    transform[5]
                ) || 0;


            const scaleX =
                Number(
                    transform[0]
                ) || 1;


            const scaleY =
                Number(
                    transform[3]
                ) || 1;


            const height =
                Number(
                    item.height
                ) ||
                Math.abs(
                    scaleY
                ) ||
                10;


            const width =
                Number(
                    item.width
                ) || 0;


            return {

                text:
                    item.str,

                x,

                y,

                width,

                height,

                scaleX,

                scaleY,

                fontName:
                    item.fontName ||
                    null,

                hasEOL:
                    Boolean(
                        item.hasEOL
                    ),

                original:
                    item,

            };
        });
}


// ============================================
// ORDEN ESPACIAL
// ============================================

export function sortTextItems(
    items
) {

    return [...items].sort(
        (a, b) => {

            const yDifference =
                Math.abs(
                    a.y - b.y
                );


            /*
             * Primero agrupamos verticalmente.
             */

            if (
                yDifference > 3
            ) {

                return b.y - a.y;
            }


            /*
             * Dentro de la misma línea:
             * izquierda → derecha.
             */

            return a.x - b.x;
        }
    );
}