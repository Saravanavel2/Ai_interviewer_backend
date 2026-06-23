const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const dotenv = require('dotenv');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const { getDb } = require('./config/db');
const {
  isGibberish,
  extractSkills,
  segmentResumeRegex,
  callGemini,
  parseJsonSafely,
  generateImprovedVersion
} = require('./services/aiService');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'prepmate-secret-key-123';

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Helper to clean and strip JSON wrappers or numbering from question text
function cleanQuestionText(text) {
  if (!text) return '';
  let clean = text.trim();
  
  function extractStringValue(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'object') {
      if (obj.question && typeof obj.question === 'string') return obj.question;
      if (obj.question_text && typeof obj.question_text === 'string') return obj.question_text;
      if (obj.text && typeof obj.text === 'string') return obj.text;
      if (obj.description && typeof obj.description === 'string') return obj.description;
      
      const vals = Object.values(obj);
      for (const val of vals) {
        const found = extractStringValue(val);
        if (found) return found;
      }
    }
    return null;
  }

  if (clean.startsWith('{') && clean.endsWith('}')) {
    try {
      const parsed = JSON.parse(clean);
      if (parsed && (parsed.title || parsed.description || parsed.templates)) {
        return text; // Preserve coding question JSON format as-is
      }
      const extracted = extractStringValue(parsed);
      if (extracted) {
        clean = extracted.trim();
      }
    } catch (e) {
      const match = clean.match(/^\{\s*["']?[a-zA-Z0-9_-]+["']?\s*:\s*["']([\s\S]*?)["']\s*\}$/);
      if (match) {
        clean = match[1].trim();
      }
    }
  }

  // Also remove any leading numbering like "1. ", "q1: ", "q2. ", "(1) ", "1) ", etc.
  clean = clean.replace(/^(?:q?\d+[\.\):\-\s]+)+/i, '');
  return clean.trim();
}

// Helper to generate UUIDs
function uuid() {
  return crypto.randomUUID();
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

// Route: User Onboarding
app.post('/api/onboard', async (req, res) => {
  const { name, email, target_role, target_company, api_key } = req.body;

  if (!target_role || !target_company) {
    return res.status(400).json({ error: 'Target role and target company are required.' });
  }

  try {
    const db = await getDb();
    const userId = uuid();

    await db.run(
      'INSERT INTO users (id, name, email, target_role, target_company, api_key) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, name || 'Anonymous', email || '', target_role, target_company, api_key || '']
    );

    const token = jwt.sign(
      {
        userId,
        name: name || 'Anonymous',
        target_role,
        target_company,
        api_key: api_key || ''
      },
      JWT_SECRET
    );

    res.status(201).json({
      token,
      user: { id: userId, name, target_role, target_company }
    });
  } catch (error) {
    console.error('Error during onboarding:', error);
    res.status(500).json({ error: 'Failed to onboard user.' });
  }
});

// Route: Resume Upload & Parsing
app.post('/api/resume/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No resume file uploaded.' });
  }

  const { userId, api_key } = req.user;

  try {
    const db = await getDb();
    let rawText = '';
    const originalName = req.file.originalname.toLowerCase();

    console.log(`Parsing uploaded resume locally: ${req.file.originalname}`);
    if (originalName.endsWith('.pdf')) {
      const parsedPdf = await pdfParse(req.file.buffer);
      rawText = parsedPdf.text;
    } else if (originalName.endsWith('.docx') || originalName.endsWith('.doc')) {
      const parsedDoc = await mammoth.extractRawText({ buffer: req.file.buffer });
      rawText = parsedDoc.value;
    } else {
      rawText = req.file.buffer.toString('utf-8');
    }

    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ error: 'No text could be extracted from the uploaded document.' });
    }

    // Truncate rawText to prevent payload limit errors (413 Payload Too Large) with LLM APIs
    rawText = rawText.slice(0, 15000);

    const skills = extractSkills(rawText);

    const prompt = `You are a resume parser. Given the raw extracted text below, segment and classify it into these categories only if present: Summary, Technical Skills, Certifications, Projects, Internships/Experience, Education. Return strict JSON with each category mapped to its extracted content. Do not invent content not present in the text.

JSON format:
{
  "Summary": "extracted content...",
  "Technical Skills": "extracted content...",
  "Certifications": "extracted content...",
  "Projects": "extracted content...",
  "Internships/Experience": "extracted content...",
  "Education": "extracted content..."
}

If a section is completely missing, do not include its key in the JSON.

Raw Resume Text:
${rawText}`;

    let classifiedSections = {};
    // First run the local regex parser as a guaranteed base
    const regexSections = segmentResumeRegex(rawText);
    try {
      const aiResponse = await callGemini(prompt, api_key || "", true);
      const aiSections = parseJsonSafely(aiResponse);
      // Merge: AI result takes priority, but keep regex-parsed sections that AI missed
      classifiedSections = { ...regexSections, ...aiSections };
    } catch (parseError) {
      console.warn("AI parsing failed, using regex segments as fallback:", parseError.message);
      classifiedSections = regexSections;
    }

    // Ensure all core interview sections exist with at least minimal placeholder content
    const INTERVIEW_SECTIONS = ["Technical Skills", "Certifications", "Projects", "Internships/Experience", "Education"];
    for (const sec of INTERVIEW_SECTIONS) {
      if (!classifiedSections[sec] || !classifiedSections[sec].trim()) {
        // Check if skills can fill Technical Skills
        if (sec === "Technical Skills" && skills.length > 0) {
          classifiedSections[sec] = skills.join(', ');
        } else {
          classifiedSections[sec] = `This section was not explicitly found in the resume. Candidate should discuss their ${sec.toLowerCase()} relevant to the target role.`;
        }
      }
    }

    const resumeId = uuid();

    // Insert Resume
    await db.run(
      'INSERT INTO resumes (id, user_id, raw_text) VALUES (?, ?, ?)',
      [resumeId, userId, rawText]
    );

    // Insert detected sections
    for (const [sectionType, content] of Object.entries(classifiedSections)) {
      if (content && typeof content === 'string' && content.trim()) {
        await db.run(
          'INSERT INTO resume_sections (id, resume_id, section_type, extracted_text) VALUES (?, ?, ?, ?)',
          [uuid(), resumeId, sectionType, content]
        );
      }
    }

    res.json({
      resumeId,
      skills,
      sections: classifiedSections
    });
  } catch (error) {
    console.error('Error parsing/uploading resume:', error.message);
    res.status(500).json({
      error: 'Failed to parse resume.',
      details: error.message
    });
  }
});

// Route: Get ATS Resume Score and Feedback
app.get('/api/resume/:resumeId/ats-score', authenticateToken, async (req, res) => {
  const { resumeId } = req.params;
  const { target_company, target_role, api_key } = req.user;

  try {
    const db = await getDb();
    const resume = await db.get(
      'SELECT * FROM resumes WHERE id = ?',
      [resumeId]
    );

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found.' });
    }

    // Cache is role+company specific — if role/company changed, always reanalyze
    if (resume.ats_score !== null && resume.ats_feedback) {
      try {
        const cachedFeedback = JSON.parse(resume.ats_feedback);
        // Only use cache if it was computed for the same role+company
        if (
          cachedFeedback.cached_role === target_role &&
          cachedFeedback.cached_company === target_company
        ) {
          return res.json({
            ats_score: resume.ats_score,
            matching_keywords: cachedFeedback.matching_keywords || [],
            missing_keywords: cachedFeedback.missing_keywords || [],
            feedback: cachedFeedback.feedback || []
          });
        }
      } catch (e) {
        // Fall through to regenerate if parsing fails
      }
    }

    console.log(`Calculating ATS score for role: ${target_role} at ${target_company}`);

    // Count words and unique technical terms in resume for context
    const resumeWordCount = resume.raw_text ? resume.raw_text.split(/\s+/).length : 0;

    const prompt = `You are a senior ATS (Applicant Tracking System) engine used by top-tier tech recruiters.

Your task: analyze the SPECIFIC resume text below and score it for the SPECIFIC role and company given.
Do NOT return generic or template scores. Base EVERY value strictly on the actual resume content.

=== TARGET ROLE: ${target_role} ===
=== TARGET COMPANY: ${target_company} ===
=== RESUME WORD COUNT: ~${resumeWordCount} words ===

=== FULL RESUME TEXT ===
${resume.raw_text}
=== END RESUME ===

Instructions:
1. Read the entire resume carefully and extract actual skills, tools, technologies, and keywords present.
2. Compare those against what a real recruiter at "${target_company}" typically screens for in a "${target_role}" candidate.
3. Compute an ATS match score from 0–100 reflecting the actual alignment:
   - Consider keyword density, section structure, quantification, relevant experience, and tool coverage.
   - Do NOT default to 70–75. If the resume is weak, score it below 60. If strong, score above 80.
4. List 5-8 ACTUAL matching keywords/skills you found verbatim in the resume text above.
5. List 5-8 keywords/skills that are MISSING from this resume but are standard requirements for "${target_role}" at "${target_company}".
6. Provide 3-4 specific, actionable improvement tips referencing actual content from this resume.

Return ONLY this strict JSON:
{
  "ats_score": <integer 0-100>,
  "matching_keywords": ["keyword1", "keyword2", ...],
  "missing_keywords": ["keyword1", "keyword2", ...],
  "feedback": [
    "Specific tip referencing actual resume content...",
    "Another specific tip..."
  ]
}`;

    const aiResponse = await callGemini(prompt, api_key || '', true);
    const parsedData = parseJsonSafely(aiResponse);

    const score = typeof parsedData.ats_score === 'number'
      ? Math.min(100, Math.max(0, parsedData.ats_score))
      : 65;

    const feedbackPayload = {
      cached_role: target_role,
      cached_company: target_company,
      matching_keywords: parsedData.matching_keywords || [],
      missing_keywords: parsedData.missing_keywords || [],
      feedback: parsedData.feedback || []
    };

    // Cache in DB with role+company metadata so future requests with different role reanalyze
    await db.run(
      'UPDATE resumes SET ats_score = ?, ats_feedback = ? WHERE id = ?',
      [score, JSON.stringify(feedbackPayload), resumeId]
    );

    res.json({
      ats_score: score,
      matching_keywords: feedbackPayload.matching_keywords,
      missing_keywords: feedbackPayload.missing_keywords,
      feedback: feedbackPayload.feedback
    });

  } catch (error) {
    console.error('Error generating ATS score:', error.message);
    res.status(500).json({ error: 'Failed to generate ATS score.' });
  }
});

// Route: Start Interview Session
app.post('/api/session/start', authenticateToken, async (req, res) => {
  const { userId } = req.user;

  try {
    const db = await getDb();
    const sessionId = uuid();

    await db.run(
      'INSERT INTO interview_sessions (id, user_id) VALUES (?, ?)',
      [sessionId, userId]
    );

    res.status(201).json({ sessionId });
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start interview session.' });
  }
});

// Route: Generate Questions for a Section
app.post('/api/session/:sessionId/generate-questions', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  const { section_name, section_content } = req.body;
  const { target_company, target_role, api_key } = req.user;

  if (!section_name || !section_content) {
    return res.status(400).json({ error: 'Section name and content are required.' });
  }

  try {
    const db = await getDb();

    console.log(`Generating questions for section: ${section_name}`);

    // Helper to sanitize section content (cleans up interleaved two-column PDF sections)
    const sanitizeSectionContent = (name, content) => {
      if (!content) return '';
      const lines = content.split('\n');
      const cleanedParts = [];

      for (const line of lines) {
        // Split on bullet points to separate merged columns
        const parts = line.split(/(?:[•\*\-]\s+|[\u2022\u2023\u25E6\u2043]\s*)/);
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;

          if (name === 'Education') {
            const isAcademic = /university|college|school|institute|academy|b\.e|b\.s|b\.tech|m\.s|m\.tech|phd|mba|b\.sc|degree|cgpa|gpa|hsc|ssc|marks|diploma|science|engineering|curriculum|coursework|studies|study|present|grade|graduated|class|matriculation|\d+%|bachelor|master|btech|be|bs|mtech|me|ms|cse|ece|it/i.test(trimmed);
            const isWorkOrProject = /developer|intern|freelance|project|developed|built|implemented|designed|engineered|worked on|deployed|scaled|optimized|git|github|api|backend|frontend|full-stack|spring boot|django|express|react|database/i.test(trimmed);
            
            if (isAcademic && !isWorkOrProject) {
              cleanedParts.push(trimmed);
            }
          } else if (name === 'Certifications') {
            const isCert = /certif|credential|course|training|nptel|internshala|infosys|academy|licence|license|completion|passed|exam/i.test(trimmed);
            const isWorkOrProject = /freelance|developer|internship|intern|employment|company|worked as/i.test(trimmed);
            
            if (isCert && !isWorkOrProject) {
              cleanedParts.push(trimmed);
            }
          } else {
            cleanedParts.push(trimmed);
          }
        }
      }

      if (cleanedParts.length === 0) {
        return content;
      }
      return cleanedParts.join('\n');
    };

    const sanitizedContent = sanitizeSectionContent(section_name, section_content);

    // Build a completely separate prompt per section type so intents never bleed across sections
    const buildSectionPrompt = () => {
      const header = `You are a senior technical interviewer at ${target_company} hiring for the role of ${target_role}.\n\nCandidate's "${section_name}" resume section:\n---\n${sanitizedContent}\n---\n\n`;
      const footer = `\nReturn strict JSON — exactly 4 items:\n{"questions": ["q1", "q2", "q3", "q4"]}`;

      if (section_name === 'Education') {
        return header +
`You are evaluating the candidate's ACADEMIC BACKGROUND ONLY.

DO NOT ask about: personal projects, GitHub repos, side projects, internships, or work experience.
ONLY ask about: university coursework, academic subjects, degree relevance, theory-to-practice gap, and how their academic preparation maps to ${target_company}'s ${target_role} expectations.

Generate exactly 4 questions:
1. Which specific academic subject or module from their degree is most directly relevant to the day-to-day work of a ${target_role} at ${target_company}, and how?
2. Ask how a specific CS principle they studied (algorithms, OS, networks, databases) would apply to a real engineering challenge at ${target_company}.
3. What is the biggest gap between their academic curriculum and what ${target_company} actually expects a ${target_role} to know on day one — and what are they doing to close it?
4. How has their university education specifically prepared them for the technical depth (distributed systems, system design, algorithms) that ${target_company}'s ${target_role} interview process demands?` + footer;
      }

      if (section_name === 'Certifications') {
        return header +
`You are evaluating the candidate's PROFESSIONAL CERTIFICATIONS ONLY.

DO NOT ask about academic coursework, personal projects, or generic definitions.
ONLY ask about: how they applied certified knowledge in real work, practical limits they found, why they chose these certifications, and how the certification helps them at ${target_company}.

Generate exactly 4 questions:
1. Ask them to explain a core concept from their certification that goes beyond surface-level — how they used it in a real scenario.
2. Describe a specific situation where the knowledge from their certification directly influenced how they solved a real technical problem.
3. Why did they choose this specific certification over alternatives in the same domain — what does it signal about their technical direction as a ${target_role}?
4. ${target_company} values engineers who convert knowledge into production outcomes. How does this certification translate into specific value for the work a ${target_role} does at ${target_company}?` + footer;
      }

      if (section_name === 'Technical Skills') {
        return header +
`You are evaluating the candidate's TECHNICAL SKILLS STACK ONLY.

Questions must reference specific technologies listed in the section above.
ONLY ask about: production experience with listed tools, why they chose specific technologies, debugging/performance scenarios, and how their stack fits ${target_company}'s engineering environment.

Generate exactly 4 questions:
1. Pick one technology listed and ask: what is the most non-trivial or complex aspect of it they've worked with — go beyond tutorials or documentation-level knowledge?
2. Ask about a real performance issue or production bug they debugged using one of the listed technologies — what was the root cause and fix?
3. They listed multiple technologies — when would they choose one specific tool over a common alternative? Give a real scenario where the distinction mattered.
4. ${target_company} runs high-throughput, distributed, data-intensive systems. How would two specific technologies from their list work together to solve a problem at ${target_company}'s ${target_role} scale that they haven't faced before?` + footer;
      }

      if (section_name === 'Projects') {
        return header +
`You are evaluating the candidate's PROJECTS ONLY.

Questions must reference the specific project name, technologies, or details visible in the section above.
ONLY ask about: architecture decisions made in the project, scaling/debugging challenges, technical debt, testing approach, and how the project maps to ${target_company}'s production environment.

Generate exactly 4 questions:
1. Ask how they handled data consistency, state management, or a core technical challenge specific to this project — name the actual project from the section.
2. Describe the hardest bug or performance bottleneck they hit while building this project — how did they isolate the root cause?
3. Why did they choose a specific technology or architecture pattern for this project instead of a simpler alternative — what trade-offs did that introduce?
4. ${target_company} runs systems at massive scale with strict reliability SLAs. If they were asked to productionize this specific project to meet ${target_company}'s ${target_role} engineering bar, what would be the first 3 things they would change?` + footer;
      }

      if (section_name === 'Internships/Experience') {
        return header +
`You are evaluating the candidate's WORK EXPERIENCE ONLY.

Questions must reference specific details from the experience described above.
ONLY ask about: quantified contributions, production incidents, technical decisions owned, team collaboration challenges, and how this experience maps to ${target_company}'s ${target_role} expectations.

Generate exactly 4 questions:
1. Ask about the most technically complex aspect of a specific task or system they worked on — name something from the section above, and ask them to explain the internal mechanics.
2. Tell me about a time in this role when something broke in production and they had to debug it under pressure — walk through the process.
3. They made a specific technical choice in this role — why that approach over the obvious alternative? What constraints shaped the decision?
4. ${target_company} expects ${target_role} engineers to own features end-to-end from requirements through production monitoring. Based on this experience, describe the most complete example of end-to-end ownership they had — and how that readies them for ${target_company}'s level of autonomy.` + footer;
      }

      // Generic fallback for any unlisted section
      return header +
`Generate exactly 4 questions that probe the content of the "${section_name}" section above.

${section_name} section rules:
1. Ask about the deepest technical aspect of something mentioned in the section — not surface-level.
2. Ask for a real scenario where they used what is described here under pressure or constraint.
3. Ask why they made a specific choice visible in the section instead of a common alternative.
4. Ask how what they've described here directly applies to the work of a ${target_role} at ${target_company} — connect explicitly to ${target_company}'s engineering context.` + footer;
    };

    const prompt = buildSectionPrompt();

    const aiResponse = await callGemini(prompt, api_key || "", true);
    const parsedData = parseJsonSafely(aiResponse);
    const questionsList = parsedData.questions || [];
    const savedQuestions = [];

    for (let questionItem of questionsList) {
      let questionText = '';
      if (typeof questionItem === 'string') {
        questionText = questionItem;
      } else if (questionItem && typeof questionItem === 'object') {
        questionText = questionItem.question || questionItem.question_text || questionItem.text;
        if (!questionText) {
          const vals = Object.values(questionItem);
          const firstStrVal = vals.find(v => typeof v === 'string' && v.trim().length > 0);
          if (firstStrVal) {
            questionText = firstStrVal;
          } else {
            questionText = JSON.stringify(questionItem);
          }
        }
      }
      
      questionText = cleanQuestionText(questionText);
      if (!questionText) continue;

      // Fail-safe post-processing validations to prevent cross-section overlaps
      if (section_name === 'Education') {
        const hasProjectOverlap = /react|angular|vue|spring|express|django|flask|postgres|postgresql|mongodb|mysql|sqlite|redis|docker|kubernetes|aws|gcp|git|github|api|rest|easan mart|prepmate|internship|work experience|freelance/i.test(questionText);
        if (hasProjectOverlap) {
          console.warn(`[Education Guard] Rejected project/work-overlapping question: "${questionText}". Replacing with academic fallback.`);
          const fallbackPool = [
            `Among the subjects you studied, which one gave you the deepest understanding of how real production systems work — and give me a concrete example of where that understanding would apply to a ${target_role} role at ${target_company}?`,
            `Tell me about a time during your studies when you had to apply a core CS principle — like cache locality, concurrency control, or network latency — to solve a practical engineering problem.`,
            `You chose to study in this academic direction. How specifically does your degree's curriculum map to what ${target_company} expects a ${target_role} to know on day one, and where are the gaps?`,
            `How has your university education specifically prepared you for the technical depth (distributed systems, system design, algorithms) that ${target_company}'s ${target_role} interview process demands?`
          ];
          questionText = fallbackPool[savedQuestions.length % fallbackPool.length];
        }
      } else if (section_name === 'Certifications') {
        const hasWorkOverlap = /freelance|developer|internship|intern|employment|company|worked as|easan mart|prepmate/i.test(questionText);
        if (hasWorkOverlap) {
          console.warn(`[Certifications Guard] Rejected work-overlapping question: "${questionText}". Replacing with cert fallback.`);
          const fallbackPool = [
            `Describe a core concept from your certification that goes beyond surface-level — how have you applied it in a real scenario?`,
            `Tell me about a specific situation where the knowledge from your certification directly influenced how you solved a real technical problem.`,
            `Why did you pursue this specific certification rather than an alternative in the same domain — what does it signal about the direction of your technical development as a ${target_role}?`,
            `How does this certification translate into specific value for the work a ${target_role} does at ${target_company}?`
          ];
          questionText = fallbackPool[savedQuestions.length % fallbackPool.length];
        }
      }

      const questionId = uuid();
      await db.run(
        'INSERT INTO questions (id, session_id, question_text, topic, difficulty, is_technical, section_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [questionId, sessionId, questionText, section_name, 'Medium', 0, section_name]
      );
      savedQuestions.push({ id: questionId, question_text: questionText, section_name });
    }

    res.json({ questions: savedQuestions });
  } catch (error) {
    console.error('Error generating section questions:', error.message);
    res.status(500).json({ error: 'Failed to generate questions for this section.' });
  }
});

// Route: Submit User Answer & Score It
app.post('/api/session/:sessionId/answer', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  const { question_id, answer_text, coding_language, compilation_status } = req.body;
  const { target_company, target_role, api_key } = req.user;

  if (!question_id || !answer_text) {
    return res.status(400).json({ error: 'Question ID and answer text are required.' });
  }

  try {
    const db = await getDb();

    // Fetch Question details
    const question = await db.get(
      'SELECT * FROM questions WHERE id = ? AND session_id = ?',
      [question_id, sessionId]
    );

    if (!question) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    question.question_text = cleanQuestionText(question.question_text);

    const answerId = uuid();

    // Save initial answer record
    await db.run(
      'INSERT INTO answers (id, question_id, answer_text, coding_language, compilation_status) VALUES (?, ?, ?, ?, ?)',
      [answerId, question_id, answer_text, coding_language || null, compilation_status || null]
    );

    // Call communication scoring
    console.log('Scoring communication quality...');
    let commScore;
    if (isGibberish(answer_text)) {
      commScore = {
        clarity: 0,
        structure: 0,
        confidence: 0,
        conciseness: 0,
        overall: 0,
        one_line_feedback: "The response contains unrecognizable characters or gibberish. Communication score is graded as 0."
      };
    } else if (question.is_technical === 2) {
      // Evaluate code communication quality (readability, commenting, layout)
      const promptCommCoding = `You are a code reviewer scoring the readability, layout, commenting, and modularity of this code snippet:
Language: ${coding_language || 'Code'}
Code:
${answer_text}

Provide scores from 0 to 100 for each dimension:
- clarity (naming conventions and commenting quality)
- structure (layout, spacing, and bracket indentations)
- confidence (modular structure, exception/null handling)
- conciseness (DRY principles and complexity cleanliness)
- overall (overall code clean readability average)

Return JSON: {clarity, structure, confidence, conciseness, overall, one_line_feedback}`;

      const commResponse = await callGemini(promptCommCoding, api_key || "", true);
      commScore = parseJsonSafely(commResponse);
    } else {
      const promptComm = `Score the following interview answer purely on communication quality (clarity, structure, confidence, conciseness) on a 0-100 scale, ignoring technical correctness entirely. Answer: ${answer_text}. Return JSON: {clarity, structure, confidence, conciseness, overall, one_line_feedback}.

CRITICAL INSTRUCTIONS:
1. If the answer is gibberish, score clarity, structure, confidence, conciseness, and overall all as 0, and set one_line_feedback dynamically explaining that the answer contains gibberish or unrecognizable text.
2. If the answer is extremely short, trivial, or lacks substance (e.g., "hello", "hi", "yes", "no", "ok"), score clarity, structure, confidence, conciseness, and overall all between 5 and 15, and write one_line_feedback dynamically explaining why their specific response (e.g., they only said "hello") is too brief to evaluate communication quality.

All scoring fields must be numbers between 0 and 100, overall should be a weighted average, and one_line_feedback should be a short text summary.`;

      const commResponse = await callGemini(promptComm, api_key || "", true);
      commScore = parseJsonSafely(commResponse);
    }

    await db.run(
      'INSERT INTO communication_scores (id, answer_id, clarity, structure, confidence, conciseness, overall) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        uuid(),
        answerId,
        commScore.clarity || 0,
        commScore.structure || 0,
        commScore.confidence || 0,
        commScore.conciseness || 0,
        commScore.overall || 0
      ]
    );

    let feedbackText = commScore.one_line_feedback || '';
    let resultPayload = {
      communication: commScore
    };

    if (question.is_technical === 2) {
      // Coding round evaluation
      console.log('Evaluating coding round answer...');
      let parsedQuestionText = question.question_text;
      try {
        const parsed = JSON.parse(question.question_text);
        parsedQuestionText = `${parsed.title}\n\nDescription:\n${parsed.description}`;
      } catch (e) {}

      // Check if the code is truly empty or just the template placeholder
      const isEmptyCode = (code) => {
        const stripped = code.trim();
        if (!stripped) return true;
        // Remove all comments, whitespace-only lines, and common placeholder patterns
        const noComments = stripped
          .replace(/\/\/.*$/gm, '')     // JS single-line comments
          .replace(/\/\*[\s\S]*?\*\//g, '') // JS block comments
          .replace(/#.*$/gm, '')         // Python comments
          .replace(/\/\/.*$/gm, '')      // Java comments
          .trim();
        if (!noComments) return true;
        // Only whitespace or empty lines remain
        const lines = noComments.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return true;
        // Common template starters with no real logic added
        const templatePatterns = [
          /^\s*\/\/\s*write your solution/i,
          /^\s*\/\/\s*your code here/i,
          /^\s*\/\/\s*solution/i,
          /^\s*pass\s*$/i,           // Python empty function
          /^\s*return\s+null\s*;?\s*$/i,
          /^\s*return\s+none\s*;?\s*$/i,
          /^\s*return\s+0\s*;?\s*$/i,
          /^\s*\{\s*\}\s*$/,         // Empty braces only
          /^\s*function\s+\w+\s*\(.*\)\s*\{\s*\}\s*$/i, // Empty function
        ];
        if (lines.length <= 2 && templatePatterns.some(p => p.test(stripped))) return true;
        // Very short code that adds nothing meaningful (< 10 real chars after stripping)
        const realChars = noComments.replace(/[\s{}();,]/g, '');
        if (realChars.length < 10) return true;
        return false;
      };

      let codingEval;
      if (isGibberish(answer_text) || isEmptyCode(answer_text)) {
        codingEval = {
          correctness_score: 0,
          feedback: "No solution was submitted. The code editor was empty or contained only the template placeholder without any actual implementation. A score of 0 is assigned. Please write a complete solution to receive a score."
        };
      } else {
        const codeLineCount = answer_text.trim().split('\n').length;
        const promptCoding = `You are a senior technical interviewer at ${target_company} evaluating a LIVE coding round submission for the role of ${target_role}.

Problem Statement:
${parsedQuestionText}

Language: ${coding_language || 'Code'}
Lines of Code Written: ${codeLineCount}
Compilation/Run Status: ${compilation_status || 'Not compiled'}

Candidate's Submitted Code:
\`\`\`${coding_language || ''}
${answer_text}
\`\`\`

Evaluation Instructions (STRICT — do NOT default to a high score):
1. Read the ENTIRE code carefully before scoring.
2. Determine if the code actually SOLVES the problem above — not just whether it compiles.
3. Score correctness from 0 to 100 based ONLY on what is written:
   - 0: Empty, template only, or completely unrelated code
   - 1-20: Code exists but is fundamentally broken, wrong algorithm, or doesn't address the problem
   - 21-40: Partial attempt — correct idea but major logic errors or missing core cases
   - 41-60: Moderate solution — solves basic cases but misses edge cases or has inefficiencies
   - 61-80: Good solution — mostly correct with minor issues in edge cases or complexity
   - 81-100: Excellent solution — correct, efficient, handles edge cases, clean code
4. If compilation_status shows an error and the code is clearly broken, that should significantly lower the score.
5. If the code is just a comment like '// TODO' or a single return statement, score it 0-5.
6. Do NOT give a high score if the code is minimal or does not implement the actual algorithm.

Return ONLY this strict JSON:
{
  "correctness_score": <integer 0-100, based strictly on the code above>,
  "feedback": "<specific analysis of what the code does or doesn't do correctly, referencing actual code lines>"
}`;

        const codingEvalResponse = await callGemini(promptCoding, api_key || '', true);
        codingEval = parseJsonSafely(codingEvalResponse);

        // Validate score is a real number, not AI hallucination
        if (typeof codingEval.correctness_score !== 'number') {
          codingEval.correctness_score = 0;
        }
        codingEval.correctness_score = Math.min(100, Math.max(0, Math.round(codingEval.correctness_score)));
      }

      await db.run(
        'INSERT INTO technical_scores (id, answer_id, correctness_score) VALUES (?, ?, ?)',
        [uuid(), answerId, codingEval.correctness_score || 0]
      );

      feedbackText = `${codingEval.feedback}\n\nCode Documentation Feedback: ${feedbackText}`;
      resultPayload.technical = codingEval;

    } else if (question.is_technical === 1) {
      // Technical round evaluation
      console.log('Evaluating technical answer...');
      let techEval;
      if (isGibberish(answer_text)) {
        techEval = {
          correctness_score: 0,
          feedback: "The response contains unrecognizable characters or gibberish. Technical score is graded as 0. Please explain the answer clearly."
        };
      } else {
        const promptTech = `You are a technical interviewer at ${target_company} for the role of ${target_role}.
Evaluate the candidate's answer to the technical question.
Question: ${question.question_text}
Topic: ${question.topic || 'Fundamentals'}
Candidate Answer: ${answer_text}

Provide a correctness score (0 to 100) and short analytical feedback.

CRITICAL INSTRUCTIONS:
1. If the candidate's answer is gibberish, assign a correctness_score of 0 and write custom feedback stating that the answer contains unrecognizable text and they should answer clearly.
2. If the candidate's answer is extremely short, trivial, or lacks substance (e.g., "hello", "hi", "yes", "no", "ok"), assign a correctness_score of 5 and write custom feedback explaining dynamically why their specific response (e.g., they only said "hello") is insufficient and does not address the technical question.
3. If the candidate's answer is completely off-topic or non-technical (e.g., talking about hobbies like going to the cinema, personal details, or completely unrelated subjects), assign a correctness_score between 0 and 10 and write custom feedback explaining dynamically why the answer is off-topic and which specific technical concepts (such as database indexes, event loops, or security protocols depending on the topic) were missed.

Return strict JSON format:
{
  "correctness_score": 85,
  "feedback": "constructive analysis of correctness and gaps..."
}`;

        const techEvalResponse = await callGemini(promptTech, api_key || "", true);
        techEval = parseJsonSafely(techEvalResponse);
      }

      await db.run(
        'INSERT INTO technical_scores (id, answer_id, correctness_score) VALUES (?, ?, ?)',
        [uuid(), answerId, techEval.correctness_score || 0]
      );

      feedbackText = `${techEval.feedback}\n\nCommunication Feedback: ${feedbackText}`;
      resultPayload.technical = techEval;

    } else {
      // Resume round evaluation
      console.log(`Evaluating resume round section: ${question.section_name}`);
      const resume = await db.get(
        'SELECT r.id FROM resumes r JOIN interview_sessions s ON r.user_id = s.user_id WHERE s.id = ?',
        [sessionId]
      );
      
      let sectionContent = '';
      if (resume) {
        const sectionRecord = await db.get(
          'SELECT extracted_text FROM resume_sections WHERE resume_id = ? AND section_type = ?',
          [resume.id, question.section_name]
        );
        if (sectionRecord) {
          sectionContent = sectionRecord.extracted_text;
        }
      }

      let resumeEval;
      if (isGibberish(answer_text)) {
        // Generate a proper section-specific rewrite instead of echoing original or generic hardcode
        const sectionSkillsGib = extractSkills(sectionContent).slice(0, 6).join(', ') || question.section_name;
        resumeEval = {
          strong: "None — the answer was unrecognizable.",
          weak: `The response contained unrecognizable text and could not be evaluated. For a ${target_role} at ${target_company}, clearly articulate: (1) specific technologies used and their architectural role, (2) measurable impact with numbers, (3) design decisions you personally owned.`,
          improved_version: generateImprovedVersion(question.section_name, sectionContent, sectionSkillsGib, target_company, target_role)
        };
      } else {
        // Extract just the technologies/skills from the section for context (don't pass full text to avoid the LLM copying it)
        const sectionSkills = extractSkills(sectionContent).slice(0, 10).join(', ') || 'listed technologies';
        const sectionFirstLine = sectionContent.split('\n')[0].slice(0, 120);

        const promptResume = `You are a resume writer and career coach specializing in ${target_role} at ${target_company}.

CONTEXT (do not copy — use only as reference for technologies and skills):
- Section type: ${question.section_name}
- Key technologies/skills detected: ${sectionSkills}
- Section summary: "${sectionFirstLine}..."
- Candidate's interview answer: "${answer_text.slice(0, 300)}"

TASK: Produce a JSON response with exactly three fields:

"strong": One sentence naming the 1-2 specific things in this section that already align well with ${target_company}'s ${target_role} expectations (name the exact tool, metric, or phrase). If nothing is strong, write "None — the section lacks demonstrable impact metrics."

"weak": Two to three sentences describing EXACTLY what is missing for ${target_company}'s ${target_role} bar. Be specific: name the missing metric types (e.g., throughput numbers, latency percentiles, user scale), missing practices (e.g., observability, CI/CD ownership, system design evidence), and name 2-3 concrete things the candidate should add.

"improved_version": Write 4 bullet points for the REWRITTEN ${question.section_name} section. RULES:
  - Each bullet MUST start with one of these verbs: Architected / Engineered / Scaled / Optimized / Deployed / Built / Led / Reduced / Automated / Designed
  - Each bullet MUST include a specific number or percentage (e.g., 40%, 10K users, 200ms, 3 months)
  - Reference the technologies: ${sectionSkills}
  - Tailor every bullet to show impact relevant to a ${target_role} at ${target_company}
  - DO NOT copy any phrase from the original section. Write entirely new sentences.
  - Format: use \n to separate bullets, no dashes or hyphens at the start

Return ONLY valid JSON:
{
  "strong": "...",
  "weak": "...",
  "improved_version": "bullet1\nbullet2\nbullet3\nbullet4"
}`;

        const resumeEvalResponse = await callGemini(promptResume, api_key || "", true);
        resumeEval = parseJsonSafely(resumeEvalResponse);
      }

      // Update resume section improved version
      if (resume) {
        await db.run(
          'UPDATE resume_sections SET improved_version = ? WHERE resume_id = ? AND section_type = ?',
          [resumeEval.improved_version, resume.id, question.section_name]
        );
      }

      feedbackText = `Strong: ${resumeEval.strong}\n\nWeaknesses: ${resumeEval.weak}\n\nSuggested Resume Revision:\n${resumeEval.improved_version}`;
      resultPayload.resumeFeedback = resumeEval;
    }

    // Save final feedback block
    await db.run(
      'INSERT INTO feedbacks (id, answer_id, ai_feedback) VALUES (?, ?, ?)',
      [uuid(), answerId, feedbackText]
    );

    resultPayload.feedback = feedbackText;
    res.json(resultPayload);

  } catch (error) {
    console.error('Error scoring answer:', error.message);
    res.status(500).json({ error: 'Failed to evaluate answer.' });
  }
});

// Route: Generate Technical Interview Round Questions
app.post('/api/session/:sessionId/generate-technical-round', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  const { target_company, target_role, api_key } = req.user;

  try {
    const db = await getDb();

    // Retrieve parsed skills from user's active resume
    const resume = await db.get(
      'SELECT r.id, r.raw_text FROM resumes r JOIN interview_sessions s ON r.user_id = s.user_id WHERE s.id = ?',
      [sessionId]
    );

    let skills = [];
    if (resume) {
      // Find skills in database or extract keywords from raw text as fallback
      const sections = await db.all(
        'SELECT extracted_text FROM resume_sections WHERE resume_id = ? AND section_type = ?',
        [resume.id, 'Technical Skills']
      );
      if (sections && sections.length > 0) {
        skills = sections[0].extracted_text.split(/, | |\n/).map(s => s.trim()).filter(Boolean);
      }
    }

    console.log('Generating technical round questions...');
    const skillsStr = skills.slice(0, 15).join(", ");
    const prompt = `You are a senior technical interviewer at ${target_company} hiring for the role of ${target_role}.
Generate a set of 3-5 technical interview questions based on the candidate's resume and target role.
The questions should be a mix of:
1. Role-specific fundamentals (e.g. databases, algorithms, architecture).
2. Company-specific interview style questions.
3. Resume-derived situational questions (e.g. 'You mentioned using X, tell me about a time you solved Y...').

Resume skills identified: ${skillsStr}

Return strict JSON format:
{
  "questions": [
    {
      "question_text": "question prompt...",
      "topic": "topic area...",
      "difficulty": "Easy/Medium/Hard"
    },
    ...
  ]
}`;

    const aiResponse = await callGemini(prompt, api_key || "", true);
    const parsedData = parseJsonSafely(aiResponse);
    const questionsList = parsedData.questions || [];
    const savedQuestions = [];

    for (let q of questionsList) {
      let questionText = '';
      if (typeof q === 'string') {
        questionText = q;
      } else if (q && typeof q === 'object') {
        questionText = q.question_text || q.question || q.text;
        if (!questionText) {
          const vals = Object.values(q);
          const firstStrVal = vals.find(v => typeof v === 'string' && v.trim().length > 0);
          if (firstStrVal) {
            questionText = firstStrVal;
          } else {
            questionText = JSON.stringify(q);
          }
        }
      }

      questionText = cleanQuestionText(questionText);
      if (!questionText) continue;

      const questionId = uuid();
      await db.run(
        'INSERT INTO questions (id, session_id, question_text, topic, difficulty, is_technical) VALUES (?, ?, ?, ?, ?, ?)',
        [questionId, sessionId, questionText, q.topic || 'Fundamentals', q.difficulty || 'Medium', 1]
      );
      savedQuestions.push({
        id: questionId,
        question_text: questionText,
        topic: q.topic || 'Fundamentals',
        difficulty: q.difficulty || 'Medium'
      });
    }

    res.json({ questions: savedQuestions });
  } catch (error) {
    console.error('Error generating technical questions:', error.message);
    res.status(500).json({ error: 'Failed to generate technical round questions.' });
  }
});

// Route: Generate Coding Question
app.post('/api/session/:sessionId/generate-coding-question', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  const { target_company, target_role, api_key } = req.user;

  try {
    const db = await getDb();

    console.log(`Generating coding round question for role: ${target_role} at ${target_company}`);

    const prompt = `You are a senior technical interviewer at ${target_company} for the ${target_role} role.
Generate a coding interview question for a live assessment.
Return ONLY a JSON object with these exact fields: title, description, difficulty, topic, templates.
- title: short problem name (string)
- description: full problem statement with examples and constraints (string, use newlines with \\n)
- difficulty: one of Easy, Medium, Hard
- topic: the algorithm/data structure topic
- templates: object with python, java, and javascript starter code strings
Make it relevant to ${target_role} interviews. Do not include anything outside the JSON object.`;

    const aiResponse = await callGemini(prompt, api_key || '', true);
    console.log('Raw coding question AI response:', aiResponse ? aiResponse.substring(0, 300) : 'null');

    let parsedData = {};
    try {
      parsedData = parseJsonSafely(aiResponse);
    } catch (parseErr) {
      console.error('Failed to parse coding question JSON:', parseErr.message);
    }

    const title = (typeof parsedData.title === 'string' && parsedData.title.trim()) ? parsedData.title.trim() : null;
    const description = (typeof parsedData.description === 'string' && parsedData.description.trim()) ? parsedData.description.trim() : null;
    const difficulty = (typeof parsedData.difficulty === 'string' && parsedData.difficulty.trim()) ? parsedData.difficulty.trim() : 'Medium';
    const topic = (typeof parsedData.topic === 'string' && parsedData.topic.trim()) ? parsedData.topic.trim() : 'Algorithms';

    const getFallback = () => {
      const lower = target_role.toLowerCase();
      if (lower.includes('frontend') || lower.includes('react') || lower.includes('web')) {
        return {
          title: 'Flatten Nested Array',
          description: 'Write a function that flattens a deeply nested array into a single-level array.\n\nExample:\nInput: [1, [2, [3, [4]], 5]]\nOutput: [1, 2, 3, 4, 5]\n\nConstraints:\n- The input may be nested to any depth\n- Do not use Array.prototype.flat()',
          topic: 'Arrays & Recursion',
          difficulty: 'Medium'
        };
      }
      if (lower.includes('backend') || lower.includes('node') || lower.includes('java') || lower.includes('python')) {
        return {
          title: 'LRU Cache',
          description: 'Design and implement an LRU (Least Recently Used) cache.\n\nImplement the LRUCache class:\n- LRUCache(int capacity): Initialize the LRU cache with capacity.\n- int get(int key): Return the value if key exists, otherwise return -1.\n- void put(int key, int value): Update or insert. Evict the least recently used key if capacity is exceeded.\n\nBoth operations must run in O(1) time complexity.',
          topic: 'Data Structures & Design',
          difficulty: 'Medium'
        };
      }
      return {
        title: 'Valid Parentheses',
        description: 'Given a string s containing just the characters \'(\', \')\', \'{\', \'}\', \'[\' and \']\', determine if the input string is valid.\n\nA string is valid if:\n- Open brackets are closed by the same type of brackets.\n- Open brackets are closed in the correct order.\n- Every close bracket has a corresponding open bracket.\n\nExample:\nInput: s = "()[]{}" → Output: true\nInput: s = "(]" → Output: false',
        topic: 'Stack & Strings',
        difficulty: 'Easy'
      };
    };

    const fallback = getFallback();
    const finalTitle = title || fallback.title;
    const finalDescription = description || fallback.description;
    const finalDifficulty = difficulty || fallback.difficulty;
    const finalTopic = topic || fallback.topic;

    const templates = (parsedData.templates && typeof parsedData.templates === 'object')
      ? parsedData.templates
      : {
          python: `# ${finalTitle}\ndef solution():\n    # Write your solution here\n    pass`,
          java: `// ${finalTitle}\nclass Solution {\n    public static void main(String[] args) {\n        // Write your solution here\n    }\n}`,
          javascript: `// ${finalTitle}\nfunction solution() {\n    // Write your solution here\n}`
        };

    const questionId = uuid();
    const questionData = {
      title: finalTitle,
      description: finalDescription,
      templates
    };

    await db.run(
      'INSERT INTO questions (id, session_id, question_text, topic, difficulty, is_technical) VALUES (?, ?, ?, ?, ?, ?)',
      [questionId, sessionId, JSON.stringify(questionData), finalTopic, finalDifficulty, 2]
    );

    console.log(`Coding question saved: "${finalTitle}" (${finalDifficulty}) — Topic: ${finalTopic}`);

    res.json({
      id: questionId,
      title: finalTitle,
      description: finalDescription,
      templates,
      topic: finalTopic,
      difficulty: finalDifficulty
    });
  } catch (error) {
    console.error('Error generating coding question:', error.message);
    res.status(500).json({ error: 'Failed to generate coding question.' });
  }
});

// Route: Compile and Execute Code Sandbox
app.post('/api/session/:sessionId/compile', authenticateToken, async (req, res) => {
  const { code, language } = req.body;
  const { api_key } = req.user;

  if (!code || !language) {
    return res.status(400).json({ error: 'Code and language are required.' });
  }

  try {
    const prompt = `You are a code execution compiler sandbox. The user has submitted a code snippet in language: ${language}.
Code:
${code}

Simulate compiling and running this code under standard execution constraints.
1. If there are syntax errors, compile errors, runtime errors, or logical exceptions (e.g. index out of bounds), return the exact error logs and standard tracebacks that a real ${language} compiler or runtime would throw. Set "success": false.
2. If the code compiles and runs successfully, return the exact console output (stdout) that the code would produce. Set "success": true.
3. Keep the "output" formatting clean, mimicking a terminal screen (e.g. showing compiler output or stdout).

Return strict JSON format:
{
  "success": true,
  "output": "stdout output or error log traceback...",
  "explanation": "Brief explanation of how the code was compiled and run, or syntax errors found..."
}`;

    const aiResponse = await callGemini(prompt, api_key || "", true);
    const parsedData = parseJsonSafely(aiResponse);
    res.json(parsedData);
  } catch (error) {
    console.error('Compiler simulation error:', error);
    res.status(500).json({ error: 'Compiler execution failed.', details: error.message });
  }
});

// Route: Get Session Final Report
app.get('/api/session/:sessionId/report', authenticateToken, async (req, res) => {
  const { sessionId } = req.params;
  const { target_company, target_role, api_key, userId } = req.user;

  try {
    const db = await getDb();

    // Check if report already exists for this session
    const existingReport = await db.get(
      'SELECT * FROM final_reports WHERE session_id = ?',
      [sessionId]
    );

    if (existingReport) {
      const plans = await db.all(
        'SELECT * FROM action_plans WHERE report_id = ? ORDER BY priority DESC',
        [existingReport.id]
      );
      
      // Fetch resume sections with improvements
      const resume = await db.get('SELECT id FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1', [userId]);
      let resumeSections = [];
      if (resume) {
        resumeSections = await db.all(
          'SELECT section_type, extracted_text, improved_version FROM resume_sections WHERE resume_id = ?',
          [resume.id]
        );
      }

      // Fetch technical scoring performance
      const qnas = await db.all(`
        SELECT q.question_text, q.topic, q.difficulty, q.is_technical, q.section_name, a.answer_text, ts.correctness_score, f.ai_feedback, cs.overall as comm_overall, cs.clarity, cs.structure, cs.confidence, cs.conciseness
        FROM questions q
        JOIN answers a ON q.id = a.question_id
        LEFT JOIN technical_scores ts ON a.id = ts.answer_id
        LEFT JOIN feedbacks f ON a.id = f.answer_id
        LEFT JOIN communication_scores cs ON a.id = cs.answer_id
        WHERE q.session_id = ?
      `, [sessionId]);

      const cleanedQnas = qnas.map(q => ({
        ...q,
        question_text: cleanQuestionText(q.question_text)
      }));

      return res.json({
        report: existingReport,
        action_plan: plans,
        resumeSections,
        qnas: cleanedQnas
      });
    }

    // If report does not exist, build it
    console.log('Retrieving session statistics for final synthesis...');
    const resume = await db.get('SELECT id FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1', [userId]);
    
    let resumeSections = [];
    if (resume) {
      resumeSections = await db.all(
        'SELECT section_type, extracted_text, improved_version FROM resume_sections WHERE resume_id = ?',
        [resume.id]
      );
    }

    const qnas = await db.all(`
      SELECT q.question_text, q.topic, q.difficulty, q.is_technical, q.section_name, a.answer_text, ts.correctness_score, f.ai_feedback, cs.overall as comm_overall, cs.clarity, cs.structure, cs.confidence, cs.conciseness
      FROM questions q
      JOIN answers a ON q.id = a.question_id
      LEFT JOIN technical_scores ts ON a.id = ts.answer_id
      LEFT JOIN feedbacks f ON a.id = f.answer_id
      LEFT JOIN communication_scores cs ON a.id = cs.answer_id
      WHERE q.session_id = ?
    `, [sessionId]);

    // Format fields for synthesizer (truncating long text fields to avoid 413 Payload Too Large errors)
    const sectionFeedbackList = qnas.filter(q => q.is_technical === 0).map(q => ({
      section_name: q.section_name,
      question: q.question_text ? q.question_text.slice(0, 150) : '',
      user_answer: q.answer_text ? q.answer_text.slice(0, 150) : '',
      // Extract weaknesses and strengths, discarding the Suggested Resume Revision (which is the longest part)
      ai_critique: q.ai_feedback ? q.ai_feedback.split('\n\nSuggested Resume Revision:')[0].slice(0, 400) : ''
    }));

    const technicalQna = qnas.filter(q => q.is_technical === 1).map(q => ({
      question: q.question_text ? q.question_text.slice(0, 150) : '',
      topic: q.topic,
      user_answer: q.answer_text ? q.answer_text.slice(0, 150) : '',
      correctness_score: q.correctness_score
    }));

    const commScores = qnas.map(q => ({
      question: q.question_text ? q.question_text.slice(0, 100) : '',
      overall: q.comm_overall
    }));

    console.log('Calling final report synthesizer...');
    const sectionFeedbackStr = JSON.stringify(sectionFeedbackList);
    const technicalQnaStr = JSON.stringify(technicalQna);
    const commScoresStr = JSON.stringify(commScores);
    
    const prompt = `You are an expert technical interviewer and executive career coach. Given the full session data of a candidate's mock interview:
- Resume section feedback: ${sectionFeedbackStr}
- Technical Q&A performance: ${technicalQnaStr}
- Communication score stats: ${commScoresStr}

Produce a highly detailed, professional, and actionable preparation plan tailored exactly for their upcoming interview at "${target_company}" for the role of "${target_role}".

CRITICAL DIRECTIONS FOR THE METRICS AND ACTION ITEMS:
1. DETAILED SYNTHESES:
   - "resume_summary": Provide a highly detailed, two-paragraph critique analyzing the candidate's resume domain alignment (e.g. backend, frontend, infrastructure, data science) for "${target_company}". Detail what areas of their experience fit well and what specific gaps or missing metrics exist in comparison to standard SDE/hiring expectations at "${target_company}" for a "${target_role}".
   - "technical_summary": Provide a two-paragraph diagnostic assessment analyzing their technical responses, depth of domain knowledge, system design concepts, and problem-solving approach. Contrast their answers directly with "${target_company}"'s specific technical standard (e.g., scale challenges, database choices, algorithm correctness, clean code) for a "${target_role}".
2. MULTI-SENTENCE ACTION PLAN (CRITICAL - AVOID REPETITION & BOILERPLATE):
   - You MUST generate exactly 3 or 4 action items in "action_plan".
   - DO NOT use any repetitive sentence structures or boilerplate patterns across the recommendations.
   - DO NOT start recommendations with the same phrase (such as "To address the gap in...", "The candidate should...", "Improve...", etc.). Every single recommendation card MUST start with a completely different sentence structure and direct action verb or context.
   - Each recommendation must target a completely distinct area of improvement (e.g. one for a specific technical design gap found in the Q&A, one for a resume metric/impact improvement, and one for communication structure/filler words). DO NOT repeat the same advice (like STAR methodology, microservices, or Prometheus/Grafana) across multiple cards.
   - Each recommendation MUST be a detailed, multi-sentence paragraph (at least 3-4 sentences, ~60-80 words).
   - Each recommendation must detail:
     (a) WHAT the gap or improvement area is, citing their specific domain (e.g. frontend component lifecycles, database indexing systems, API routing patterns) and their actual interview answers.
     (b) WHY this specific gap is a critical risk for "${target_company}"'s unique hiring criteria for "${target_role}" (e.g., Google's focus on scale/algorithms, Meta's focus on execution speed/architecture, startups' focus on fast shipping/ambiguity).
     (c) HOW exactly to address this gap (providing concrete frameworks, specific design patterns, technical concepts to study, or resume phrasing techniques).

Return strict JSON format:
{
  "resume_summary": "First paragraph detailing resume strengths/domain alignment... \n\nSecond paragraph detailing resume gaps/improvements specific to ${target_company} SDE bar...",
  "technical_summary": "First paragraph analyzing technical answer depth and domain mastery... \n\nSecond paragraph detailing specific concepts missed and architectural gaps for ${target_company} SDE...",
  "action_plan": [
    {
      "recommendation": "A highly detailed 3-4 sentence paragraph that defines the exact topic, target company risk, and specific action steps to study and implement. Begin with a unique verb or hook - DO NOT use repetitive starting patterns like 'To address the gap in...'.",
      "priority": "High/Medium/Low"
    },
    ...
  ]
}`;

    const aiResponse = await callGemini(prompt, api_key || "", true);
    const synthesis = parseJsonSafely(aiResponse);
    const reportId = uuid();

    const commTrendStr = commScores.map(c => c.overall || 0).join(',');

    await db.run(
      'INSERT INTO final_reports (id, user_id, session_id, resume_summary, technical_summary, communication_trend) VALUES (?, ?, ?, ?, ?, ?)',
      [reportId, userId, sessionId, synthesis.resume_summary || '', synthesis.technical_summary || '', commTrendStr]
    );

    const actionPlans = synthesis.action_plan || [];
    for (const plan of actionPlans) {
      await db.run(
        'INSERT INTO action_plans (id, report_id, recommendation, priority) VALUES (?, ?, ?, ?)',
        [uuid(), reportId, plan.recommendation, plan.priority || 'Medium']
      );
    }

    // Retrieve newly created records to return
    const reportRecord = await db.get('SELECT * FROM final_reports WHERE id = ?', [reportId]);
    const plansList = await db.all('SELECT * FROM action_plans WHERE report_id = ? ORDER BY priority DESC', [reportId]);

    const cleanedQnas = qnas.map(q => ({
      ...q,
      question_text: cleanQuestionText(q.question_text)
    }));

    res.json({
      report: reportRecord,
      action_plan: plansList,
      resumeSections,
      qnas: cleanedQnas
    });

  } catch (error) {
    console.error('Error generating final report:', error.message);
    res.status(500).json({ error: 'Failed to generate final interview report.' });
  }
});

app.listen(port, () => {
  console.log(`Node.js express backend server running on port ${port}`);
});
