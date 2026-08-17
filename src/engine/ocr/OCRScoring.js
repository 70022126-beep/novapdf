// ============================================
// NOVAPDF OCR SCORING ENGINE
// VERSION 1.0
// ============================================
//
// Evalúa diferentes resultados OCR.
//
// Objetivo:
//
// No elegir simplemente el resultado
// con mayor cantidad de palabras.
//
// Se consideran:
//
// 1. Confianza OCR
// 2. Cantidad de palabras
// 3. Cantidad de líneas
// 4. Cantidad de bloques
//
// ============================================


function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );

}


// ============================================
// NORMALIZAR MÉTRICA
// ============================================

function normalize(
    value,
    reference
) {

    if (
        !reference ||
        reference <= 0
    ) {

        return 0;

    }


    return clamp(
        value / reference,
        0,
        1
    );

}


// ============================================
// CALCULAR SCORE
// ============================================

export function calculateOCRScore(
    result,
    reference
) {

    const confidence =
        Number(
            result?.confidence || 0
        );


    const words =
        result?.words?.length || 0;


    const lines =
        result?.lines?.length || 0;


    const blocks =
        result?.blocks?.length || 0;

    const analysis =
        result?.analysis || null;
       const structuralScore =
    analysis?.statistics
        ? (
            (
                normalize(
                    analysis.statistics.paragraphCount || 0,
                    analysis.statistics.blockCount || 1
                ) * 0.40
            ) +
            (
                normalize(
                    analysis.statistics.lineCount || 0,
                    analysis.statistics.wordCount || 1
                ) * 0.30
            ) +
            (
                clamp(
                    Number(
                        analysis.statistics.averageConfidence || 0
                    ) / 100,
                    0,
                    1
                ) * 0.30
            )
        )
        : 0;
    // ========================================
    // MÉTRICAS NORMALIZADAS
    // ========================================

    const confidenceScore =
        clamp(
            confidence / 100,
            0,
            1
        );


    const wordScore =
        normalize(
            words,
            reference.maxWords
        );


    const lineScore =
        normalize(
            lines,
            reference.maxLines
        );


    const blockScore =
        normalize(
            blocks,
            reference.maxBlocks
        );


    // ========================================
    // SCORE FINAL
    // ========================================
    //
    // Confianza       40%
    // Palabras        30%
    // Líneas          20%
    // Bloques         10%
    //
    // ========================================

    const baseScore =

    (
        confidenceScore *
        0.40
    ) +

    (
        wordScore *
        0.30
    ) +

    (
        lineScore *
        0.20
    ) +

    (
        blockScore *
        0.10
    );


const score =

    (
        baseScore *
        0.85
    ) +

    (
        structuralScore *
        0.15
    );

    return {

        score:
            Number(
                (
                    score * 100
                ).toFixed(2)
            ),
        structuralScore:
            Number(
                (
                    structuralScore * 100
                ).toFixed(2)
            ),
        confidenceScore:
            Number(
                (
                    confidenceScore * 100
                ).toFixed(2)
            ),

        wordScore:
            Number(
                (
                    wordScore * 100
                ).toFixed(2)
            ),

        lineScore:
            Number(
                (
                    lineScore * 100
                ).toFixed(2)
            ),

        blockScore:
            Number(
                (
                    blockScore * 100
                ).toFixed(2)
            ),

        metrics: {

            words,

            lines,

            blocks,

            confidence,

        },

    };

}


// ============================================
// EVALUAR TODAS LAS VARIANTES
// ============================================

export function rankOCRResults(
    results
) {

    if (
        !Array.isArray(results) ||
        results.length === 0
    ) {

        return {

            ranked: [],

            best: null,

        };

    }


    // ========================================
    // REFERENCIAS
    // ========================================

    const maxWords =
        Math.max(
            ...results.map(
                result =>
                    result?.words?.length || 0
            )
        );


    const maxLines =
        Math.max(
            ...results.map(
                result =>
                    result?.lines?.length || 0
            )
        );


    const maxBlocks =
        Math.max(
            ...results.map(
                result =>
                    result?.blocks?.length || 0
            )
        );


    const reference = {

        maxWords,

        maxLines,

        maxBlocks,

    };


    // ========================================
    // CALCULAR
    // ========================================

    const ranked =
        results.map(
            result => {

                const scoring =
                    calculateOCRScore(
                        result,
                        reference
                    );


                return {

                    ...result,

                    scoring,

                };

            }
        );


    // ========================================
    // ORDENAR
    // ========================================

    ranked.sort(
        (
            a,
            b
        ) =>
            b.scoring.score -
            a.scoring.score
    );


    return {

        ranked,

        best:
            ranked[0] || null,

    };

}
