// ============================================
// NOVAPDF IMAGE PREPROCESSOR
// VERSION 1.1
// ============================================
//
// Pipeline:
//
// PDF Canvas
//      ↓
// Grayscale
//      ↓
// Contraste
//      ↓
// Binarización adaptativa
//
// ============================================


export function preprocessForOCR(
    sourceCanvas,
    options = {}
) {

    if (!sourceCanvas) {

        throw new Error(
            "No se proporcionó un canvas."
        );

    }


    const {

        contrast = 1.15,

        brightness = 0,

        grayscale = true,

        threshold = null,

        adaptive = false,

        windowSize = 15,

        offset = 10,

    } = options;


    const width =
        sourceCanvas.width;


    const height =
        sourceCanvas.height;


    const canvas =
        document.createElement(
            "canvas"
        );


    canvas.width =
        width;


    canvas.height =
        height;


    const context =
        canvas.getContext(
            "2d",
            {
                willReadFrequently: true,
            }
        );


    context.drawImage(
        sourceCanvas,
        0,
        0
    );


    const imageData =
        context.getImageData(
            0,
            0,
            width,
            height
        );


    const data =
        imageData.data;


    // ========================================
    // PASO 1
    // ESCALA DE GRISES + CONTRASTE
    // ========================================

    for (
        let i = 0;
        i < data.length;
        i += 4
    ) {

        let red =
            data[i];

        let green =
            data[i + 1];

        let blue =
            data[i + 2];


        if (grayscale) {

            const gray =
                (
                    red * 0.299 +
                    green * 0.587 +
                    blue * 0.114
                );


            red = gray;
            green = gray;
            blue = gray;

        }


        red =
            (
                (red - 128) *
                contrast
            ) + 128;


        green =
            (
                (green - 128) *
                contrast
            ) + 128;


        blue =
            (
                (blue - 128) *
                contrast
            ) + 128;


        red += brightness;
        green += brightness;
        blue += brightness;


        data[i] =
            Math.max(
                0,
                Math.min(
                    255,
                    red
                )
            );


        data[i + 1] =
            Math.max(
                0,
                Math.min(
                    255,
                    green
                )
            );


        data[i + 2] =
            Math.max(
                0,
                Math.min(
                    255,
                    blue
                )
            );

    }


    // ========================================
    // PASO 2
    // BINARIZACIÓN ADAPTATIVA
    // ========================================

    if (adaptive) {

        const grayValues =
            new Uint8Array(
                width * height
            );


        for (
            let y = 0;
            y < height;
            y++
        ) {

            for (
                let x = 0;
                x < width;
                x++
            ) {

                const index =
                    (
                        y * width +
                        x
                    ) * 4;


                grayValues[
                    y * width + x
                ] =
                    data[index];

            }

        }


        const radius =
            Math.max(
                0,
                Math.floor(
                    Number(windowSize) / 2
                )
            );


        // Suma horizontal de la ventana de cada
        // píxel. Esta primera pasada permite evitar
        // recorrer la ventana completa para cada
        // posición de la imagen.
        const horizontalSums =
            new Uint32Array(
                width * height
            );


        for (
            let y = 0;
            y < height;
            y++
        ) {

            const rowOffset =
                y * width;


            let rowSum = 0;

            let left = 0;

            let right = -1;


            for (
                let x = 0;
                x < width;
                x++
            ) {

                const targetLeft =
                    Math.max(
                        0,
                        x - radius
                    );


                const targetRight =
                    Math.min(
                        width - 1,
                        x + radius
                    );


                while (
                    right < targetRight
                ) {

                    right++;

                    rowSum +=
                        grayValues[
                            rowOffset +
                            right
                        ];

                }


                while (
                    left < targetLeft
                ) {

                    rowSum -=
                        grayValues[
                            rowOffset +
                            left
                        ];

                    left++;

                }


                horizontalSums[
                    rowOffset + x
                ] = rowSum;

            }

        }


        // La segunda pasada mantiene una suma
        // vertical deslizante. El coste total pasa
        // de O(width * height * windowSize²) a
        // O(width * height).
        const verticalSums =
            new Uint32Array(width);


        const initialBottom =
            Math.min(
                height - 1,
                radius
            );


        for (
            let y = 0;
            y <= initialBottom;
            y++
        ) {

            const rowOffset =
                y * width;


            for (
                let x = 0;
                x < width;
                x++
            ) {

                verticalSums[x] +=
                    horizontalSums[
                        rowOffset + x
                    ];

            }

        }


        for (
            let y = 0;
            y < height;
            y++
        ) {

            if (y > 0) {

                const rowToRemove =
                    y - radius - 1;


                if (rowToRemove >= 0) {

                    const rowOffset =
                        rowToRemove * width;


                    for (
                        let x = 0;
                        x < width;
                        x++
                    ) {

                        verticalSums[x] -=
                            horizontalSums[
                                rowOffset + x
                            ];

                    }

                }


                const rowToAdd =
                    y + radius;


                if (rowToAdd < height) {

                    const rowOffset =
                        rowToAdd * width;


                    for (
                        let x = 0;
                        x < width;
                        x++
                    ) {

                        verticalSums[x] +=
                            horizontalSums[
                                rowOffset + x
                            ];

                    }

                }

            }


            const minY =
                Math.max(
                    0,
                    y - radius
                );


            const maxY =
                Math.min(
                    height - 1,
                    y + radius
                );


            const verticalCount =
                maxY - minY + 1;


            for (
                let x = 0;
                x < width;
                x++
            ) {

                const minX =
                    Math.max(
                        0,
                        x - radius
                    );


                const maxX =
                    Math.min(
                        width - 1,
                        x + radius
                    );


                const horizontalCount =
                    maxX - minX + 1;


                const localMean =
                    verticalSums[x] /
                    (
                        horizontalCount *
                        verticalCount
                    );


                const pixel =
                    grayValues[
                        y * width +
                        x
                    ];


                const value =
                    pixel >
                    (
                        localMean -
                        offset
                    )
                        ? 255
                        : 0;


                const index =
                    (
                        y * width +
                        x
                    ) * 4;


                data[index] =
                    value;

                data[index + 1] =
                    value;

                data[index + 2] =
                    value;

            }

        }

    }


    // ========================================
    // PASO 3
    // THRESHOLD FIJO OPCIONAL
    // ========================================

    else if (
        threshold !== null
    ) {

        for (
            let i = 0;
            i < data.length;
            i += 4
        ) {

            const value =
                (
                    data[i] +
                    data[i + 1] +
                    data[i + 2]
                ) / 3;


            const binary =
                value >= threshold
                    ? 255
                    : 0;


            data[i] =
                binary;

            data[i + 1] =
                binary;

            data[i + 2] =
                binary;

        }

    }


    context.putImageData(
        imageData,
        0,
        0
    );


    return canvas;
}
