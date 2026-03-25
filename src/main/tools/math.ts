/**
 * Math utility functions for custom tools.
 * Provides basic arithmetic and equation solving.
 */

export interface QuadraticResult {
  discriminant: number;
  roots: number[];
  realRoots: number[];
  complexRoots?: Array<{ real: number; imaginary: number }>;
}

export interface PolynomialResult {
  value: number;
  error?: string;
}

/**
 * Add two numbers
 */
export function mathAdd(a: number, b: number): { result: number } {
  return {
    result: a + b,
  };
}

/**
 * Subtract two numbers
 */
export function mathSubtract(a: number, b: number): { result: number } {
  return {
    result: a - b,
  };
}

/**
 * Multiply two numbers
 */
export function mathMultiply(a: number, b: number): { result: number } {
  return {
    result: a * b,
  };
}

/**
 * Divide two numbers
 */
export function mathDivide(a: number, b: number): { result: number; error?: string } {
  if (b === 0) {
    return {
      result: 0,
      error: 'Cannot divide by zero',
    };
  }
  return {
    result: a / b,
  };
}

/**
 * Solve quadratic equation: ax^2 + bx + c = 0
 * Uses the quadratic formula: x = (-b ± √(b²-4ac)) / 2a
 */
export function mathSolveQuadratic(a: number, b: number, c: number): QuadraticResult {
  if (a === 0) {
    // Not a quadratic, treat as linear: bx + c = 0
    if (b === 0) {
      return {
        discriminant: 0,
        roots: c === 0 ? [0] : [],
        realRoots: c === 0 ? [0] : [],
      };
    }
    return {
      discriminant: 0,
      roots: [-c / b],
      realRoots: [-c / b],
    };
  }

  const discriminant = b * b - 4 * a * c;
  const twoA = 2 * a;

  if (discriminant > 0) {
    // Two real roots
    const sqrtDisc = Math.sqrt(discriminant);
    const root1 = (-b + sqrtDisc) / twoA;
    const root2 = (-b - sqrtDisc) / twoA;
    return {
      discriminant,
      roots: [root1, root2],
      realRoots: [root1, root2],
      complexRoots: undefined,
    };
  } else if (discriminant === 0) {
    // One real root (repeated)
    const root = -b / twoA;
    return {
      discriminant: 0,
      roots: [root],
      realRoots: [root],
      complexRoots: undefined,
    };
  } else {
    // Complex roots
    const realPart = -b / twoA;
    const imaginaryPart = Math.sqrt(-discriminant) / twoA;
    return {
      discriminant,
      roots: [],
      realRoots: [],
      complexRoots: [
        { real: realPart, imaginary: imaginaryPart },
        { real: realPart, imaginary: -imaginaryPart },
      ],
    };
  }
}

/**
 * Evaluate a polynomial at a given x value.
 * Polynomial is defined as: coefficients[0] + coefficients[1]*x + coefficients[2]*x^2 + ...
 * Example: for 2x^2 + 3x + 1, pass coefficients=[1, 3, 2] and x=2
 */
export function mathEvaluatePolynomial(coefficients: number[], x: number): PolynomialResult {
  if (!Array.isArray(coefficients) || coefficients.length === 0) {
    return {
      value: 0,
      error: 'Coefficients must be a non-empty array',
    };
  }

  let result = 0;
  for (let i = 0; i < coefficients.length; i++) {
    result += coefficients[i] * Math.pow(x, i);
  }

  return {
    value: result,
  };
}

/**
 * Find approximate roots of a polynomial using Newton-Raphson method.
 * coefficients: [a0, a1, a2, ...] for a0 + a1*x + a2*x^2 + ...
 * derivative: [a1, 2*a2, 3*a3, ...] computed automatically or provided
 */
export function mathFindPolynomialRoots(
  coefficients: number[],
  initialGuess: number = 0,
  iterations: number = 10
): { roots: number[]; attempts: number; converged: boolean; error?: string } {
  if (!Array.isArray(coefficients) || coefficients.length === 0) {
    return {
      roots: [],
      attempts: 0,
      converged: false,
      error: 'Coefficients must be a non-empty array',
    };
  }

  // Compute derivative coefficients
  const derivative: number[] = [];
  for (let i = 1; i < coefficients.length; i++) {
    derivative.push(i * coefficients[i]);
  }

  if (derivative.length === 0) {
    // Constant polynomial
    return {
      roots: coefficients[0] === 0 ? [initialGuess] : [],
      attempts: 1,
      converged: true,
    };
  }

  let x = initialGuess;
  const roots: number[] = [];
  const tolerance = 1e-6;

  for (let i = 0; i < iterations; i++) {
    const fx = mathEvaluatePolynomial(coefficients, x);
    const fpx = mathEvaluatePolynomial(derivative, x);

    if (fx.error || fpx.error) {
      return {
        roots,
        attempts: i,
        converged: false,
        error: 'Evaluation error',
      };
    }

    if (Math.abs(fpx.value) < tolerance) {
      return {
        roots,
        attempts: i,
        converged: false,
        error: 'Derivative near zero; cannot converge',
      };
    }

    const nextX = x - fx.value / fpx.value;

    if (Math.abs(nextX - x) < tolerance) {
      roots.push(parseFloat(nextX.toFixed(6)));
      return {
        roots,
        attempts: i + 1,
        converged: true,
      };
    }

    x = nextX;
  }

  roots.push(parseFloat(x.toFixed(6)));
  return {
    roots,
    attempts: iterations,
    converged: false,
  };
}

/**
 * Solve a linear equation: ax + b = 0
 */
export function mathSolveLinear(a: number, b: number): { root: number; error?: string } {
  if (a === 0) {
    return {
      root: 0,
      error: 'Not a linear equation (a=0)',
    };
  }
  return {
    root: -b / a,
  };
}

/**
 * Solve a line equation: ax + b = c
 * Solves for x: x = (c - b) / a
 * Example: 5x + 5 = 20 → x = (20 - 5) / 5 = 3
 */
export function mathSolveLineEquation(a: number, b: number, c: number): { x: number; error?: string } {
  if (a === 0) {
    if (b === c) {
      return {
        x: 0,
        error: 'Infinite solutions (0x + b = b is always true)',
      };
    }
    return {
      x: 0,
      error: `No solution (${b} ≠ ${c})`,
    };
  }
  return {
    x: (c - b) / a,
  };
}
