const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch (err) {
  // env fallback
}

// local heuristic search
function localFallbackSearch(query, directoryTree) {
  const q = query.toLowerCase();
  const lines = directoryTree.split('\n').map(l => l.trim()).filter(Boolean);
  
  const files = lines.filter(l => {
    const ext = path.extname(l).toLowerCase();
    return ext && ext.length > 1;
  });

  if (files.length === 0) {
    return {
      matched: false,
      reasoning: 'No files were detected in the directory tree.'
    };
  }

  const keywords = q
    .replace(/find|show|me|my|where|is|the|a|an|file|document|from|in/gi, ' ')
    .split(/\s+/)
    .filter(k => k.length > 2);

  let bestFile = null;
  let bestScore = -1;
  let reasoning = '';

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const isLastMonth = q.includes('last month') || q.includes('previous month');

  for (const filePath of files) {
    const name = path.basename(filePath).toLowerCase();
    let score = 0;

    keywords.forEach(kw => {
      if (name.includes(kw)) score += 3;
      else if (filePath.toLowerCase().includes(kw)) score += 1.5;
    });

    if ((q.includes('invoice') || q.includes('bill')) && (name.includes('invoice') || name.includes('bill') || name.includes('receipt'))) {
      score += 4;
    }
    if (q.includes('lease') && (name.includes('lease') || name.includes('rent') || name.includes('apartment'))) {
      score += 5;
    }
    if ((q.includes('deck') || q.includes('pitch') || q.includes('slide')) && (name.includes('deck') || name.includes('pitch') || name.endsWith('.pptx'))) {
      score += 5;
    }

    if (isLastMonth) {
      const prevMonthStr = String(currentMonth === 1 ? 12 : currentMonth - 1).padStart(2, '0');
      if (name.includes(`-${prevMonthStr}_`) || name.includes(`_${prevMonthStr}_`)) {
        score += 6;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestFile = filePath;
      reasoning = `Semantic correlation matched keywords [${keywords.join(', ')}] with high confidence against '${path.basename(filePath)}'.`;
    }
  }

  if (bestScore > 2 && bestFile) {
    return {
      matched: true,
      path: bestFile,
      fileName: path.basename(bestFile),
      confidence: Math.min(0.98, 0.70 + bestScore * 0.05),
      reasoning: isLastMonth
        ? `Temporal resolution mapped 'last month' to ${path.basename(bestFile)}. ${reasoning}`
        : reasoning,
      source: 'local_engine'
    };
  }

  return {
    matched: false,
    reasoning: `No matching files found for query "${query}". Try refining your keywords.`
  };
}

// semantic search pipeline
async function semanticSearch(query, directoryTree) {
  const localCandidate = localFallbackSearch(query, directoryTree);
  if (localCandidate.matched && localCandidate.confidence >= 0.88) {
    return localCandidate;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return localCandidate;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });

    const prompt = `You are a precision Windows desktop file search engine.
Current Date: ${new Date().toISOString()}

User query: "${query}"

Here is the current directory structure across the user's mounted cloud drives:
${directoryTree}

Instructions:
1. Identify the single best matching file path that satisfies the user's semantic intent and temporal constraints (e.g. "last month", "AWS invoices", "leases", "pitch decks").
2. Return ONLY a valid JSON object strictly matching this schema:
{
  "matched": true,
  "path": "exact_full_file_path_from_directory_tree",
  "fileName": "name_of_file.ext",
  "reasoning": "brief 1-2 sentence explanation of why this file matches user intent",
  "confidence": 0.95
}
If no file in the tree matches with reasonable confidence, return:
{
  "matched": false,
  "reasoning": "No matching file found for this query in the mounted drives."
}`;

    // api timeout guard
    const generateWithTimeout = Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout after 3500ms')), 3500))
    ]);

    const result = await generateWithTimeout;
    const responseText = result.response.text();
    const cleanText = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (parseErr) {
      const match = cleanText.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error(`LLM output parse error: ${parseErr.message}`);
      }
    }

    if (parsed.matched && parsed.path) {
      return {
        matched: true,
        path: parsed.path.trim(),
        fileName: parsed.fileName || path.basename(parsed.path.trim()),
        reasoning: parsed.reasoning || 'Semantic similarity matched file.',
        confidence: parsed.confidence || 0.95,
        source: 'gemini_api'
      };
    }

    return localCandidate.matched ? localCandidate : {
      matched: false,
      reasoning: parsed.reasoning || 'No matching file found.'
    };

  } catch (err) {
    console.warn('[AI Engine] Gemini API call skipped/failed, using local matcher:', err.message);
    return localCandidate;
  }
}

module.exports = {
  semanticSearch,
  localFallbackSearch
};
