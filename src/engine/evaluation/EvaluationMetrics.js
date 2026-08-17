function normalizeText(value) {
    return String(value ?? "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
}

export function editDistance(firstSequence, secondSequence) {
    const first = Array.from(firstSequence);
    const second = Array.from(secondSequence);
    const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
    const current = new Array(second.length + 1);

    for (let row = 1; row <= first.length; row += 1) {
        current[0] = row;
        for (let column = 1; column <= second.length; column += 1) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1)
            );
        }
        for (let column = 0; column <= second.length; column += 1) {
            previous[column] = current[column];
        }
    }

    return previous[second.length];
}

export function calculateCER(reference, hypothesis) {
    const normalizedReference = normalizeText(reference);
    const normalizedHypothesis = normalizeText(hypothesis);
    const errors = editDistance(normalizedReference, normalizedHypothesis);
    return {
        errors,
        referenceCharacters: normalizedReference.length,
        cer: normalizedReference.length
            ? Number((errors / normalizedReference.length).toFixed(4))
            : normalizedHypothesis.length
              ? 1
              : 0,
        accuracy: normalizedReference.length
            ? Number((Math.max(0, 1 - errors / normalizedReference.length) * 100).toFixed(2))
            : normalizedHypothesis.length
              ? 0
              : 100,
    };
}

export function calculateWER(reference, hypothesis) {
    const referenceWords = normalizeText(reference).split(/\s+/).filter(Boolean);
    const hypothesisWords = normalizeText(hypothesis).split(/\s+/).filter(Boolean);
    const errors = editDistance(referenceWords, hypothesisWords);
    return {
        errors,
        referenceWords: referenceWords.length,
        wer: referenceWords.length
            ? Number((errors / referenceWords.length).toFixed(4))
            : hypothesisWords.length
              ? 1
              : 0,
        accuracy: referenceWords.length
            ? Number((Math.max(0, 1 - errors / referenceWords.length) * 100).toFixed(2))
            : hypothesisWords.length
              ? 0
              : 100,
    };
}

function normalizeCell(value) {
    return normalizeText(typeof value === "object" ? value?.text : value).toLowerCase();
}

export function calculateTableAccuracy(referenceRows = [], hypothesisRows = []) {
    const maximumRows = Math.max(referenceRows.length, hypothesisRows.length);
    let expectedCells = 0;
    let matchedCells = 0;

    for (let rowIndex = 0; rowIndex < maximumRows; rowIndex += 1) {
        const referenceRow = referenceRows[rowIndex] || [];
        const hypothesisRow = hypothesisRows[rowIndex] || [];
        const maximumColumns = Math.max(referenceRow.length, hypothesisRow.length);
        for (let columnIndex = 0; columnIndex < maximumColumns; columnIndex += 1) {
            const expected = normalizeCell(referenceRow[columnIndex]);
            const actual = normalizeCell(hypothesisRow[columnIndex]);
            if (rowIndex < referenceRows.length && columnIndex < referenceRow.length) {
                expectedCells += 1;
                if (expected === actual) matchedCells += 1;
            }
        }
    }

    return {
        expectedCells,
        matchedCells,
        accuracy: expectedCells
            ? Number(((matchedCells / expectedCells) * 100).toFixed(2))
            : 100,
    };
}

export function calculateReadingOrderScore(referenceIds = [], hypothesisIds = []) {
    const hypothesisPosition = new Map(
        hypothesisIds.map((id, index) => [String(id), index])
    );
    const common = referenceIds.filter((id) => hypothesisPosition.has(String(id)));
    let comparablePairs = 0;
    let concordantPairs = 0;

    for (let first = 0; first < common.length; first += 1) {
        for (let second = first + 1; second < common.length; second += 1) {
            comparablePairs += 1;
            if (
                hypothesisPosition.get(String(common[first])) <
                hypothesisPosition.get(String(common[second]))
            ) {
                concordantPairs += 1;
            }
        }
    }

    return {
        comparablePairs,
        concordantPairs,
        score: comparablePairs
            ? Number(((concordantPairs / comparablePairs) * 100).toFixed(2))
            : 100,
    };
}

export function calculateGeometricFidelity(referenceBox = {}, hypothesisBox = {}) {
    const left = Math.max(Number(referenceBox.x) || 0, Number(hypothesisBox.x) || 0);
    const top = Math.max(Number(referenceBox.y) || 0, Number(hypothesisBox.y) || 0);
    const right = Math.min(
        (Number(referenceBox.x) || 0) + (Number(referenceBox.width) || 0),
        (Number(hypothesisBox.x) || 0) + (Number(hypothesisBox.width) || 0)
    );
    const bottom = Math.min(
        (Number(referenceBox.y) || 0) + (Number(referenceBox.height) || 0),
        (Number(hypothesisBox.y) || 0) + (Number(hypothesisBox.height) || 0)
    );
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const referenceArea =
        (Number(referenceBox.width) || 0) * (Number(referenceBox.height) || 0);
    const hypothesisArea =
        (Number(hypothesisBox.width) || 0) * (Number(hypothesisBox.height) || 0);
    const union = referenceArea + hypothesisArea - intersection;
    return {
        iou: union ? Number((intersection / union).toFixed(4)) : 1,
        score: union ? Number(((intersection / union) * 100).toFixed(2)) : 100,
    };
}

export function evaluateText(reference, hypothesis) {
    return {
        cer: calculateCER(reference, hypothesis),
        wer: calculateWER(reference, hypothesis),
    };
}

