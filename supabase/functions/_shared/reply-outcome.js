const POSITIVE_PATTERNS = [
  /\b(?:still live|still going|still progressing)\b/i,
  /\b(?:please|can you|could you|would you)\b.{0,50}\b(?:price|quote|tender)\b/i,
  /\b(?:package|packages|works|work)\b.{0,30}\b(?:open|available for pricing|available to price)\b/i,
  /\byes[,\s]+(?:it is|the project is|please|we are|that is correct)\b/i,
  /\b(?:send|issue|provide)\b.{0,30}\b(?:drawings|information|tender|enquiry)\b/i,
];

const NEGATIVE_PATTERNS = [
  /^no[,\s]+(?:it is not|it isn't|the project is not|the project isn't)\b/i,
  /\b(?:no longer|not)\s+(?:live|going ahead|progressing)\b/i,
  /\b(?:project|job|works|work)\b.{0,20}\b(?:cancelled|canceled|completed|finished|on hold)\b/i,
  /\bno\s+(?:relevant\s+)?packages?\b.{0,20}\b(?:open|available)\b/i,
  /\b(?:nothing|none)\s+(?:is\s+|are\s+)?(?:open|available)\b/i,
  /\bnot interested\b/i,
];

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return '';
}

export function classifyProjectReply(input) {
  const text = String(input || '')
    .split(/\bon .{0,160}\bwrote:/i)[0]
    .split(/\bfrom:.{0,120}\bsent:/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const positiveEvidence = firstMatch(POSITIVE_PATTERNS, text);
  const negativeEvidence = firstMatch(NEGATIVE_PATTERNS, text);

  if (positiveEvidence && !negativeEvidence) {
    return {
      outcome: 'positive',
      confidence: 0.95,
      evidence: `Explicit positive wording: ${positiveEvidence}`,
    };
  }
  if (negativeEvidence && !positiveEvidence) {
    return {
      outcome: 'negative',
      confidence: 0.95,
      evidence: `Explicit negative wording: ${negativeEvidence}`,
    };
  }
  if (positiveEvidence && negativeEvidence) {
    return {
      outcome: 'manual_review',
      confidence: 0.35,
      evidence: 'Reply contains conflicting positive and negative wording',
    };
  }
  return {
    outcome: 'manual_review',
    confidence: 0.4,
    evidence: 'No explicit yes/no project outcome was detected',
  };
}
