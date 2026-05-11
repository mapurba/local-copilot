/**
 * Math Tools
 * Basic arithmetic and equation solving.
 */

function mathAdd(a, b)      { return { result: a + b }; }
function mathSubtract(a, b) { return { result: a - b }; }
function mathMultiply(a, b) { return { result: a * b }; }
function mathDivide(a, b) {
  if (b === 0) return { result: 0, error: 'Cannot divide by zero' };
  return { result: a / b };
}

/** Solve linear: ax + b = 0 */
function mathSolveLinear(a, b) {
  if (a === 0) return { root: null, error: b === 0 ? 'Infinite solutions' : 'No solution' };
  return { root: -b / a };
}

/** Solve line equation: ax + b = c */
function mathSolveLineEquation(a, b, c) {
  return mathSolveLinear(a, b - c);
}

/** Solve quadratic: ax² + bx + c = 0 */
function mathSolveQuadratic(a, b, c) {
  if (a === 0) {
    if (b === 0) return { discriminant: 0, roots: c === 0 ? [0] : [], realRoots: c === 0 ? [0] : [] };
    return { discriminant: 0, roots: [-c / b], realRoots: [-c / b] };
  }
  const discriminant = b * b - 4 * a * c;
  const twoA = 2 * a;
  if (discriminant > 0) {
    const sqrtDisc = Math.sqrt(discriminant);
    return { discriminant, roots: [(-b + sqrtDisc) / twoA, (-b - sqrtDisc) / twoA], realRoots: [(-b + sqrtDisc) / twoA, (-b - sqrtDisc) / twoA] };
  } else if (discriminant === 0) {
    return { discriminant: 0, roots: [-b / twoA], realRoots: [-b / twoA] };
  } else {
    const realPart = -b / twoA;
    const imagPart = Math.sqrt(-discriminant) / twoA;
    return { discriminant, roots: [], realRoots: [], complexRoots: [{ real: realPart, imaginary: imagPart }, { real: realPart, imaginary: -imagPart }] };
  }
}

/** Evaluate polynomial: coefficients[0] + coefficients[1]*x + coefficients[2]*x² + ... */
function mathEvaluatePolynomial(coefficients, x) {
  if (!Array.isArray(coefficients) || coefficients.length === 0) return { value: 0, error: 'Coefficients must be a non-empty array' };
  let result = 0;
  for (let i = 0; i < coefficients.length; i++) result += coefficients[i] * Math.pow(x, i);
  return { value: result };
}

/** Find polynomial roots using Newton-Raphson method. */
function mathFindPolynomialRoots(coefficients, initialGuess = 0, iterations = 10) {
  if (!Array.isArray(coefficients) || coefficients.length === 0) return { roots: [], converged: false, error: 'Coefficients must be non-empty' };
  const derivative = [];
  for (let i = 1; i < coefficients.length; i++) derivative.push(i * coefficients[i]);

  let x = initialGuess;
  for (let i = 0; i < iterations; i++) {
    const fx  = mathEvaluatePolynomial(coefficients, x).value;
    const fpx = mathEvaluatePolynomial(derivative, x).value;
    if (Math.abs(fpx) < 1e-12) break;
    x = x - fx / fpx;
  }
  const finalFx = mathEvaluatePolynomial(coefficients, x).value;
  return { roots: [x], converged: Math.abs(finalFx) < 1e-6, finalValue: finalFx };
}

module.exports = { mathAdd, mathSubtract, mathMultiply, mathDivide, mathSolveLinear, mathSolveLineEquation, mathSolveQuadratic, mathEvaluatePolynomial, mathFindPolynomialRoots };
