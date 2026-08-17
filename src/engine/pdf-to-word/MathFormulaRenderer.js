import {
    Math as DocxMath,
    MathFraction,
    MathRadical,
    MathRun,
    MathSubScript,
    MathSubSuperScript,
    MathSuperScript,
} from "docx";

const COMMANDS = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    theta: "θ",
    lambda: "λ",
    mu: "μ",
    pi: "π",
    rho: "ρ",
    sigma: "σ",
    phi: "φ",
    omega: "ω",
    Gamma: "Γ",
    Delta: "Δ",
    Sigma: "Σ",
    Omega: "Ω",
    times: "×",
    cdot: "·",
    div: "÷",
    pm: "±",
    neq: "≠",
    leq: "≤",
    geq: "≥",
    approx: "≈",
    infty: "∞",
    rightarrow: "→",
    leftarrow: "←",
};

function cleanLatex(value) {
    return String(value ?? "")
        .trim()
        .replace(/^\$+|\$+$/g, "")
        .replace(/^\\\[|\\\]$/g, "")
        .trim();
}

function readBraced(source, start) {
    if (source[start] !== "{") {
        return { value: source[start] || "", next: Math.min(source.length, start + 1) };
    }
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        if (depth === 0) {
            return { value: source.slice(start + 1, index), next: index + 1 };
        }
    }
    return { value: source.slice(start + 1), next: source.length };
}

function readCommand(source, start) {
    const match = /^\\([A-Za-z]+|.)/.exec(source.slice(start));
    if (!match) return { name: "", next: start + 1 };
    return { name: match[1], next: start + match[0].length };
}

function readScript(source, start) {
    let index = start;
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] === "{") {
        const group = readBraced(source, index);
        return { children: parseSequence(group.value), next: group.next };
    }
    return {
        children: source[index] ? [new MathRun(source[index])] : [],
        next: Math.min(source.length, index + 1),
    };
}

function readAtom(source, start) {
    const character = source[start];
    if (character === "{") {
        const group = readBraced(source, start);
        return { children: parseSequence(group.value), next: group.next };
    }
    if (character === "\\") {
        const command = readCommand(source, start);
        if (command.name === "frac") {
            const numerator = readBraced(source, command.next);
            const denominator = readBraced(source, numerator.next);
            return {
                children: [
                    new MathFraction({
                        numerator: parseSequence(numerator.value),
                        denominator: parseSequence(denominator.value),
                    }),
                ],
                next: denominator.next,
            };
        }
        if (command.name === "sqrt") {
            let next = command.next;
            let degree;
            if (source[next] === "[") {
                const closing = source.indexOf("]", next + 1);
                if (closing > next) {
                    degree = parseSequence(source.slice(next + 1, closing));
                    next = closing + 1;
                }
            }
            const radicand = readBraced(source, next);
            return {
                children: [
                    new MathRadical({
                        children: parseSequence(radicand.value),
                        degree,
                    }),
                ],
                next: radicand.next,
            };
        }
        return {
            children: [new MathRun(COMMANDS[command.name] || command.name)],
            next: command.next,
        };
    }

    let end = start + 1;
    while (
        end < source.length &&
        !["\\", "{", "}", "_", "^"].includes(source[end])
    ) {
        end += 1;
    }
    return { children: [new MathRun(source.slice(start, end))], next: end };
}

function parseSequence(source) {
    const result = [];
    let index = 0;
    while (index < source.length) {
        if (source[index] === "}") {
            index += 1;
            continue;
        }
        const atom = readAtom(source, index);
        let children = atom.children;
        index = atom.next;
        let subScript = null;
        let superScript = null;
        while (source[index] === "_" || source[index] === "^") {
            const marker = source[index];
            const script = readScript(source, index + 1);
            if (marker === "_") subScript = script.children;
            else superScript = script.children;
            index = script.next;
        }
        if (subScript && superScript) {
            children = [new MathSubSuperScript({ children, subScript, superScript })];
        } else if (subScript) {
            children = [new MathSubScript({ children, subScript })];
        } else if (superScript) {
            children = [new MathSuperScript({ children, superScript })];
        }
        result.push(...children);
    }
    return result.length ? result : [new MathRun("")];
}

export function createEditableMath(latex) {
    return new DocxMath({ children: parseSequence(cleanLatex(latex)) });
}

export function normalizeFormulaText(latex) {
    return cleanLatex(latex)
        .replace(/\\([A-Za-z]+)/g, (_, command) => COMMANDS[command] || command)
        .replace(/[{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export { parseSequence as __parseFormulaSequenceForTests };
