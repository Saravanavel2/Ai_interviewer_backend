const axios = require('axios');

const TECH_KEYWORDS = new Set([
  "python", "javascript", "react", "typescript", "node.js", "node", "express", 
  "fastapi", "postgres", "postgresql", "sqlite", "docker", "aws", "gcp", "azure", 
  "kubernetes", "html", "css", "sql", "git", "java", "c++", "c#", "ruby", "rails", 
  "php", "laravel", "go", "golang", "rust", "swift", "kotlin", "vue", "angular", 
  "django", "flask", "spring", "spring boot", "mongodb", "redis", "graphql", 
  "rest", "api", "machine learning", "deep learning", "ai", "pandas", "numpy", 
  "scikit-learn", "tensorflow", "pytorch", "ci/cd", "agile", "scrum", "jira"
]);

function extractSkills(text) {
  const found = new Set();
  const textLower = text.toLowerCase();
  for (const kw of TECH_KEYWORDS) {
    const escaped = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(textLower)) {
      let formatted = kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (["html", "css", "sql", "api", "aws", "gcp", "ci/cd"].includes(kw)) {
        formatted = kw.toUpperCase();
      }
      found.add(formatted);
    }
  }
  return Array.from(found).sort().slice(0, 30);
}

function segmentResumeRegex(text) {
  const sections = {};
  let currentSection = "Summary";
  const currentContent = [];

  const headerMapping = [
    { pattern: /\b(summary|objective|profile|about me|about)\b/i, name: "Summary" },
    { pattern: /\b(skills|technical skills|technologies|proficiencies|expertise|tech stack)\b/i, name: "Technical Skills" },
    { pattern: /\b(certifications|certs|licenses|achievements)\b/i, name: "Certifications" },
    { pattern: /\b(projects|academic projects|personal projects|development projects)\b/i, name: "Projects" },
    { pattern: /\b(experience|work experience|employment|history|internships|professional experience|career)\b/i, name: "Internships/Experience" },
    { pattern: /\b(education|academic|academic background|university|qualifications)\b/i, name: "Education" }
  ];

  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;

    let isHeader = false;
    for (const mapping of headerMapping) {
      if (mapping.pattern.test(stripped.toLowerCase()) && stripped.length < 40) {
        if (currentContent.length > 0) {
          sections[currentSection] = currentContent.join('\n').trim();
        }
        currentSection = mapping.name;
        currentContent.length = 0;
        isHeader = true;
        break;
      }
    }

    if (!isHeader) {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  return sections;
}

function extractKeywordsSimple(text) {
  const words = text.match(/\b[A-Za-z0-9\.\-\#\+]{2,15}\b/g) || [];
  const extracted = [];
  const seen = new Set();
  for (const w of words) {
    const wLower = w.toLowerCase();
    if (TECH_KEYWORDS.has(wLower) && !seen.has(wLower)) {
      seen.add(wLower);
      extracted.push(w);
    }
  }
  return extracted;
}

function isGibberish(text) {
  const clean = text.trim();
  if (!clean) return true;

  const words = clean.split(/\s+/).map(w => w.replace(/[^a-zA-Z]/g, '')).filter(Boolean);
  if (words.length === 0) return true;

  const avgLen = words.reduce((acc, w) => acc + w.length, 0) / words.length;
  if (avgLen > 18) return true;

  const commonVocab = new Set([
    "the", "and", "a", "of", "to", "in", "is", "that", "it", "for", "on", "are", "as", 
    "with", "i", "at", "be", "this", "have", "from", "or", "by", "but", "not", "what", 
    "we", "when", "your", "can", "there", "use", "an", "if", "my", "me", "do", "how",
    "react", "node", "python", "js", "sql", "api", "database", "code", "run", "web",
    "data", "build", "project", "using", "work", "develop", "system", "scale", "index",
    "am", "was", "were", "been", "has", "had", "will", "would", "should", "could", "about",
    "like", "just", "so", "more", "some", "them", "their", "than", "then", "its", "our", 
    "good", "fine", "very", "me", "you", "he", "she", "they", "him", "her", "us", "them",
    "my", "mine", "your", "yours", "his", "hers", "their", "theirs", "our", "ours",
    "who", "whom", "whose", "which", "that", "this", "these", "those", "each", "every",
    "either", "neither", "any", "some", "no", "one", "all", "both", "few", "many",
    "several", "much", "more", "most", "less", "least", "other", "another", "such",
    "same", "different", "own", "self", "others", "something", "someone",
    "anything", "anyone", "nothing", "noone", "everything", "everyone", "somewhere",
    "anywhere", "nowhere", "everywhere", "here", "there", "where", "when", "why", "how",
    "yes", "no", "maybe", "please", "thanks", "thank", "hello", "hi", "hey", "well",
    "see", "look", "think", "know", "want", "give", "take", "make", "find", "get", "go",
    "come", "back", "show", "tell", "say", "call", "try", "keep", "start", "stop", "hold",
    "bring", "carry", "lead", "write", "read", "speak", "talk", "hear", "listen",
    "feel", "seem", "appear", "become", "grow", "turn", "fall", "break", "cut",
    "love", "hate", "dislike", "prefer", "enjoy", "hope", "wish", "fear", "dread",
    "cinema", "movie", "film", "music", "song", "book", "game", "play", "sport"
  ]);

  const validTechWords = new Set([
    "use", "using", "uses", "used", "api", "apis", "dev", "developer", "developers", "development",
    "sys", "system", "systems", "db", "database", "databases", "sql", "web", "website", "websites",
    "app", "apps", "application", "applications", "git", "github", "cache", "caches", "caching",
    "server", "servers", "service", "services", "cloud", "deployment", "deploy", "deployed", "testing",
    "code", "coding", "coder", "coders", "program", "programming", "programmer", "programmers",
    "software", "hardware", "network", "networks", "networking", "internet", "webpage", "webpages",
    "index", "indexes", "indexing", "search", "searching", "searched", "engine", "engines", "loop",
    "loops", "looping", "thread", "threads", "threading", "process", "processes", "processing",
    "memory", "ram", "cpu", "gpu", "storage", "disk", "drive", "drives", "file", "files", "folder",
    "folders", "directory", "directories", "path", "paths", "route", "routes", "routing", "router",
    "routers", "switch", "switches", "hub", "hubs", "port", "ports", "socket", "sockets", "connection",
    "connections", "connect", "connecting", "connected", "disconnect", "disconnecting", "disconnected"
  ]);

  const validNonVowelAbbrs = new Set([
    "db", "js", "ts", "py", "aws", "gcp", "jwt", "xml", "npm", "dns", "ssl", "ssh", "cli", "csv", 
    "sql", "css", "html", "json", "yaml", "sdk", "api", "rest", "http", "https", "uuid", "guid", 
    "cron", "cdn", "dom", "mvc", "orm", "oop", "dry", "solid", "acid", "nosql", "rdbms", "olap", 
    "oltp", "etl", "bi", "ci", "cd", "qa", "pr", "mr", "vcs", "git", "svn", "cvs", "sub", "pub"
  ]);

  const vowels = new Set("aeiouyAEIOUY");
  let validCount = 0;

  for (const w of words) {
    const wLower = w.toLowerCase();
    if (commonVocab.has(wLower) || TECH_KEYWORDS.has(wLower) || validTechWords.has(wLower)) {
      validCount++;
      continue;
    }
    if (wLower.length === 1) {
      if (["a", "i", "o", "u"].includes(wLower)) {
        validCount++;
      }
      continue;
    }

    let hasRepeats = false;
    for (let i = 0; i < wLower.length - 2; i++) {
      if (wLower[i] === wLower[i+1] && wLower[i] === wLower[i+2]) {
        hasRepeats = true;
        break;
      }
    }
    if (hasRepeats) continue;

    const hasVowel = [...wLower].some(c => vowels.has(c));
    if (!hasVowel && !validNonVowelAbbrs.has(wLower)) {
      continue;
    }

    let consonantCluster = 0;
    let maxCluster = 0;
    for (const c of wLower) {
      if (!vowels.has(c)) {
        consonantCluster++;
        if (consonantCluster > maxCluster) maxCluster = consonantCluster;
      } else {
        consonantCluster = 0;
      }
    }
    if (maxCluster >= 5) continue;

    validCount++;
  }

  const validRatio = validCount / words.length;
  return validRatio < 0.60;
}

function isShortOrTrivial(text) {
  const clean = text.trim();
  if (!clean) return true;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 3 || clean.length < 15) {
    return true;
  }
  const trivialPhrases = new Set([
    "hello", "hi", "hey", "test", "testing", "ok", "yes", "no", "sure", "yep", "nope", 
    "dunno", "i don't know", "i dont know", "no idea", "pass", "skip", "hello there", "good morning", "good afternoon"
  ]);
  if (trivialPhrases.has(clean.toLowerCase().replace(/[^a-z\s]/g, ''))) {
    return true;
  }
  return false;
}

/**
 * Builds a meaningfully rewritten resume section with action verbs + impact metrics.
 * Deliberately does NOT echo original text — used by simulation fallback only.
 */
function generateImprovedVersion(sectionName, originalContent, primaryKw, company, role) {
  const ACTION_VERBS = ['Architected', 'Engineered', 'Scaled', 'Optimized', 'Designed', 'Deployed', 'Built', 'Led', 'Reduced', 'Improved', 'Implemented', 'Developed', 'Automated', 'Integrated', 'Streamlined'];
  const v = (n) => ACTION_VERBS[n % ACTION_VERBS.length];
  const kw = primaryKw && primaryKw !== 'the technology' ? primaryKw : 'the core system';
  const sLower = sectionName.toLowerCase();

  if (sLower.includes('project')) {
    return `${v(0)} end-to-end ${sectionName} leveraging ${kw} to deliver a production-grade service handling 10,000+ concurrent requests with sub-100ms p99 latency.\n` +
           `${v(1)} RESTful API layer with JWT authentication and rate-limiting middleware, reducing unauthorized access incidents by 100% across staging and production environments.\n` +
           `${v(2)} CI/CD pipeline using GitHub Actions and Docker containerization, cutting deployment time from 45 minutes to under 8 minutes and enabling zero-downtime releases.\n` +
           `${v(3)} system for ${company}'s expected traffic patterns by implementing horizontal pod autoscaling and Redis-based session caching, improving throughput by 60%.`;
  } else if (sLower.includes('experience') || sLower.includes('internship')) {
    return `${v(0)} backend API infrastructure using ${kw}, improving average query response time by 40% through strategic database indexing and query plan optimization.\n` +
           `${v(4)} Redis caching layer for high-frequency read operations, reducing database load by 35% and enabling the service to handle peak traffic spikes at ${company} scale.\n` +
           `${v(5)} microservice deployment pipelines on AWS (EC2, RDS, S3) with blue-green deployment strategy, achieving 99.9% uptime SLA over a 6-month period.\n` +
           `${v(6)} cross-functional collaboration with Product and QA teams to deliver 3 major feature releases on schedule, each with >85% unit test coverage and comprehensive API documentation.`;
  } else if (sLower.includes('skill') || sLower.includes('technical')) {
    return `Core: ${kw}, Node.js, Python (FastAPI/Django), React/TypeScript — applied in production systems handling distributed workloads.\n` +
           `Infrastructure: Docker, Kubernetes, AWS (EC2, RDS, S3, Lambda), CI/CD with GitHub Actions — experienced in zero-downtime deployments and container orchestration.\n` +
           `Databases: PostgreSQL (advanced indexing, query optimization, connection pooling), Redis (LRU eviction, pub/sub, session caching), SQLite.\n` +
           `Practices: RESTful API design, event-driven architecture, microservices, TDD (Jest/PyTest), code review, Agile/Scrum — aligned with ${company}'s engineering culture.`;
  } else if (sLower.includes('education')) {
    return `${v(7)} strong academic foundation in Computer Science with coursework directly applicable to ${role} at ${company}: Distributed Systems, Algorithms & Data Structures, Database Systems, and Operating Systems.\n` +
           `${v(8)} consistently high academic performance (GPA above 3.7/4.0) while actively applying theory to practice through self-directed study of ${company}'s engineering blog, open-source contributions, and applied programming challenges.\n` +
           `Bridges academic knowledge and industry expectations by studying real-world system design patterns, distributed architecture trade-offs, and production engineering principles aligned with ${company}'s ${role} hiring bar.\n` +
           `Proactively closing industry gaps through structured self-learning: completed online courses in cloud computing, container orchestration, and software engineering best practices relevant to ${company}'s tech stack.`;
  } else if (sLower.includes('certification')) {
    // Extract actual certification name(s) from the original content
    const certLines = originalContent ? originalContent.split(/[\n,]/).map(l => l.trim()).filter(l => l.length > 5 && l.length < 120) : [];
    const certName = certLines.length > 0 ? certLines[0] : `${role}-relevant professional certification`;
    const certCount = certLines.length > 1 ? `${certLines.length} industry certifications` : `this certification`;
    return `Earned ${certName} — validated expertise in production architecture patterns, security best practices, and engineering standards directly relevant to ${role} at ${company}.\n` +
           `Applied ${certCount} to real-world engineering scenarios: implemented distributed caching strategies reducing query latency by 40%, designed secure OAuth 2.0 authentication flows deployed to production, and established monitoring pipelines with 99.9% uptime SLA.\n` +
           `Bridges certification knowledge with hands-on practice by building proof-of-concept systems that replicate ${company}-scale challenges, demonstrating practical application beyond exam-level understanding.\n` +
           `Continues structured professional development aligned with ${company}'s ${role} technical bar, targeting advanced cloud architecture and distributed systems design certifications.`;
  } else {
    return `${v(0)} key deliverables in this area using ${kw}, achieving measurable impact: 40% latency improvement, 60% reduction in operational overhead, and 99.9% system availability.\n` +
           `${v(1)} solutions following ${company}'s engineering standards: clean architecture, comprehensive testing (>80% coverage), and production-ready observability (metrics, logging, alerting).\n` +
           `${v(2)} technical initiatives end-to-end, from design document to production deployment, demonstrating the ownership mindset expected of a ${role} at ${company}.`;
  }
}

function generateDynamicSimulation(prompt) {
  const promptLower = prompt.toLowerCase();
  
  let company = "Google";
  let role = "Software Engineer";
  let sectionName = "Projects";
  let sectionContent = "";
  let userAnswer = "";

  const compMatch = prompt.match(/(?:interviewer at|interviews at|bar for)\s+([A-Za-z0-9\s\-]+?)(?:\s+hiring|\s+for|\.|\'s)/i);
  if (compMatch) company = compMatch[1].trim();

  const roleMatch = prompt.match(/(?:role of|specializing in)\s+([A-Za-z0-9\s\-]+?)(?:\s+interviews|\s+at|\.|\b)/i);
  if (roleMatch) role = roleMatch[1].trim();

  const secMatch = prompt.match(/(?:candidate's|improved version of this)\s+([A-Za-z0-9\/\s\-]+?)\s+section/i);
  if (secMatch) sectionName = secMatch[1].trim();

  const contentMatch1 = prompt.match(/section:\s*(.+?)\.\s*(?:Generate|Avoid)/is);
  if (contentMatch1) {
    sectionContent = contentMatch1[1].trim();
  } else {
    const contentMatch2 = prompt.match(/reads:\s*(.+?)\.\s*Their answer/is);
    if (contentMatch2) sectionContent = contentMatch2[1].trim();
  }

  const ansMatch = prompt.match(/(?:questions was|Candidate Answer|Answer):\s*(.+?)(?:\n\nProvide|\n+CRITICAL|\.\s*Provide|\.\s*Return|\Z)/is);
  if (ansMatch) userAnswer = ansMatch[1].trim();

  const isAnsGibberish = userAnswer ? isGibberish(userAnswer) : false;
  const isAnsShortOrTrivial = userAnswer ? isShortOrTrivial(userAnswer) : false;

  if (promptLower.includes("resume parser")) {
    let rawText = "";
    const rawTextMatch = prompt.match(/Raw Resume Text:\s*(.*)/is);
    if (rawTextMatch) rawText = rawTextMatch[1].trim();

    if (rawText) {
      const segmented = segmentResumeRegex(rawText);
      // Ensure all core interview sections are present — use fallback content if a section is missing from the resume text
      const REQUIRED_SECTIONS = ["Summary", "Technical Skills", "Certifications", "Projects", "Internships/Experience", "Education"];
      for (const sec of REQUIRED_SECTIONS) {
        if (!segmented[sec] || !segmented[sec].trim()) {
          // Only include non-Summary sections with placeholder text (Summary is auto-skipped by interview)
          if (sec !== "Summary") {
            segmented[sec] = `Resume content for ${sec} section (not explicitly listed — candidate should describe their relevant ${sec.toLowerCase()}).`;
          }
        }
      }
      return JSON.stringify(segmented);
    }

    return JSON.stringify({
      "Summary": `Results-driven professional targeting the ${role} position at ${company}.`,
      "Technical Skills": "Python, JavaScript, SQL, React, Docker, Git, REST APIs",
      "Projects": `Led development of a distributed search portal aligned with ${company}'s design standards.`,
      "Internships/Experience": `Software Engineer Intern. Collaborated with teams to implement high-throughput APIs.`,
      "Education": "B.S. in Computer Science."
    });
  }

  if (promptLower.includes("probe the depth") || promptLower.includes("never ask generic") || promptLower.includes("evaluating the candidate's") || promptLower.includes("generate exactly 4 questions")) {
    const kws = extractKeywordsSimple(sectionContent);
    const kw1 = kws[0] || 'the technology';
    const kw2 = kws[1] || 'your architecture';
    const kw3 = kws[2] || 'your implementation approach';

    // Section-specific question pools
    const sectionLower = sectionName.toLowerCase();
    let questions = [];

    if (sectionLower.includes('project')) {
      questions = [
        // DEPTH
        `Your project uses ${kw1}. Walk me through how you handled state management and data consistency under concurrent load — what specific design patterns did you apply?`,
        // SCENARIO
        `Tell me about the hardest bug or performance issue you encountered while building this project. How did you isolate the root cause and what was the fix?`,
        // CHOICE
        `Why did you choose ${kw2} for this project instead of a simpler or more common alternative? What trade-offs did that choice introduce?`,
        // COMPANY FIT
        `${company} runs systems at massive scale with strict reliability SLAs. If you were asked to harden this project to meet ${company}'s ${role} production standards, what would be the first three things you would change and why?`
      ];
    } else if (sectionLower.includes('experience') || sectionLower.includes('internship')) {
      questions = [
        // DEPTH
        `You worked with ${kw1} in this role. Explain the most technically complex aspect of how you used it — focus on internals, not just the API surface.`,
        // SCENARIO
        `Tell me about a time during this experience when something broke in production and you were responsible for fixing it. Walk me through your debugging process and how you prevented recurrence.`,
        // CHOICE
        `You chose ${kw2} as part of your approach here. What alternatives did you evaluate, and what made ${kw2} the right choice for the constraints you were working under?`,
        // COMPANY FIT
        `${company} expects ${role} engineers to independently own features from requirements to monitoring in production. Based on your experience here, describe the most complex ownership moment you've had — and how that prepares you for the autonomy expected at ${company}.`
      ];
    } else if (sectionLower.includes('education')) {
      questions = [
        // DEPTH
        `Among the subjects you studied, which one gave you the deepest understanding of how real production systems work — and give me a concrete example of where that understanding would apply to a ${role} role at ${company}?`,
        // SCENARIO
        `Tell me about a time during your studies when you had to apply a core CS principle — like cache locality, concurrency control, or network latency — to solve a practical engineering problem.`,
        // CHOICE
        `You chose to study in this academic direction. How specifically does your degree's curriculum map to what ${company} expects a ${role} to know on day one, and where are the gaps?`,
        // COMPANY FIT
        `${company} is known for rigorous technical interviews covering distributed systems, algorithms, and system design. How has your academic background prepared you for each of these areas, and what are you actively studying to close any remaining gaps?`
      ];
    } else if (sectionLower.includes('skill') || sectionLower.includes('technical')) {
      questions = [
        // DEPTH
        `You listed ${kw1} as a skill. Describe the most non-trivial thing you've built with it — go beyond the basics and explain the design decisions you made at the architecture level.`,
        // SCENARIO
        `Tell me about a time when ${kw2} caused an unexpected production issue or performance bottleneck. How did you diagnose it and what was the resolution?`,
        // CHOICE
        `When would you choose ${kw1} over ${kw3} (or a comparable alternative)? Give me a concrete scenario from your experience where the distinction mattered.`,
        // COMPANY FIT
        `${company}'s ${role} engineers regularly work with high-throughput, distributed, and data-intensive systems. Looking at your technical skills, specifically ${kw1} and ${kw2}, how would you apply them to solve a problem at ${company}'s scale that you haven't faced before?`
      ];
    } else if (sectionLower.includes('certification')) {
      questions = [
        // DEPTH
        `Your certification demonstrates knowledge in ${kw1 !== 'the technology' ? kw1 : 'this domain'}. Explain a core concept from it that most people only know at a surface level — and how you've applied it at a deeper level in practice.`,
        // SCENARIO
        `Tell me about a real project or task where the knowledge from your certification directly determined how you approached a problem. What would you have done differently without it?`,
        // CHOICE
        `Why did you pursue this specific certification rather than an alternative in the same domain? What does it signal about the direction of your technical development as a ${role}?`,
        // COMPANY FIT
        `${company} invests heavily in engineers who combine formal knowledge with hands-on execution. How does your certification directly translate into practical value for the work a ${role} does at ${company} — give a specific example or scenario.`
      ];
    } else {
      questions = [
        // DEPTH
        `You mentioned ${kw1} in this section. What is the most technically nuanced aspect of working with it that most candidates wouldn't know unless they've used it in production?`,
        // SCENARIO
        `Tell me about a specific situation where your experience in this area was tested under pressure or uncertainty. What did you do and what did you learn?`,
        // CHOICE
        `Why did you approach this area with ${kw2} instead of a common alternative? What trade-offs did that decision introduce?`,
        // COMPANY FIT
        `${company} looks for ${role} engineers who can connect their background to real business impact. Based on what you've described here, how would this experience translate directly into value for a team at ${company} within your first 90 days?`
      ];
    }

    return JSON.stringify({ "questions": questions.slice(0, 4) });
  }

  if (promptLower.includes("career coach") || promptLower.includes("completely rewrite")) {
    if (isAnsGibberish) {
      // Even for gibberish: rewrite the original section as improved (don't just echo it back)
      const kws = extractKeywordsSimple(sectionContent);
      const kw = kws[0] || 'your technology stack';
      return JSON.stringify({
        "strong": "None — the provided answer was unrecognizable.",
        "weak": `The answer contained unrecognizable or gibberish text and could not be evaluated. For a ${role} position at ${company}, you need to clearly articulate: (1) specific technologies used and WHY you chose them, (2) measurable impact (performance gains, scale achieved, cost savings), and (3) the architecture and design decisions you owned.`,
        "improved_version": generateImprovedVersion(sectionName, sectionContent, kw, company, role)
      });
    }

    if (isAnsShortOrTrivial) {
      const kws = extractKeywordsSimple(sectionContent);
      const kw = kws[0] || 'your stack';
      return JSON.stringify({
        "strong": "None — the response was too brief to identify strengths.",
        "weak": `The answer was too short or trivial to evaluate. For a ${role} at ${company}, your response should cover: (1) the specific technologies from your resume (${kw}) and their architectural role, (2) quantified business impact (e.g., 'reduced latency by 40%', 'scaled to 10K users'), (3) design trade-offs you consciously made, and (4) how this experience maps to ${company}'s engineering culture.`,
        "improved_version": generateImprovedVersion(sectionName, sectionContent, kw, company, role)
      });
    }

    const kws = extractKeywordsSimple(userAnswer);
    const ansKw = kws[0] || 'the implementation';
    const ansKw2 = kws[1] || 'system design';
    const contentKws = extractKeywordsSimple(sectionContent);
    const origKw = contentKws[0] || 'the system';

    return JSON.stringify({
      "strong": `The answer demonstrates hands-on familiarity with ${ansKw} and shows practical exposure to ${ansKw2}. The mention of concrete implementation details is a positive signal for a ${role} role.`,
      "weak": `For ${company}'s ${role} bar, the section needs: (1) quantified impact metrics (p99 latency, throughput, user scale, cost reduction), (2) explicit mention of architectural trade-offs made with ${origKw}, (3) evidence of production-level ownership (monitoring, alerting, incident response), and (4) ${company}-specific relevance such as distributed systems experience or high-availability design patterns.`,
      "improved_version": generateImprovedVersion(sectionName, sectionContent, ansKw, company, role)
    });
  }

  if (promptLower.includes("generate a set of 3-5 technical interview questions")) {
    const roleClean = role.toLowerCase();
    let qs = [];
    if (roleClean.includes("backend") || roleClean.includes("software")) {
      qs = [
        {
          "question_text": `How would you design a scalable cache invalidation strategy for database lookups in a high-traffic system at ${company}?`,
          "topic": "System Design",
          "difficulty": "Hard"
        },
        {
          "question_text": "What is the difference between processes and threads, and how does Node.js achieve concurrency despite being single-threaded?",
          "topic": "Concurrency",
          "difficulty": "Medium"
        },
        {
          "question_text": `Describe indexing in databases. Why would you select B-Trees over Hash indexes for index range scans under ${company} workloads?`,
          "topic": "Databases",
          "difficulty": "Medium"
        }
      ];
    } else if (roleClean.includes("frontend") || roleClean.includes("react")) {
      qs = [
        {
          "question_text": `How do React's fiber reconciliation algorithms and virtual DOM comparison cycles optimize page painting times at ${company}?`,
          "topic": "Performance",
          "difficulty": "Hard"
        },
        {
          "question_text": "What are the core differences between Client-Side Rendering (CSR), Server-Side Rendering (SSR), and Static Site Generation (SSG)?",
          "topic": "Architecture",
          "difficulty": "Medium"
        },
        {
          "question_text": "Explain standard browser security protocols (CORS, CSRF tokens, XSS mitigation) and how to protect token stores.",
          "topic": "Security",
          "difficulty": "Medium"
        }
      ];
    } else {
      qs = [
        {
          "question_text": `Walk me through how you organize data pipelines and monitor runtime metric anomalies at ${company} scale.`,
          "topic": "Infrastructure",
          "difficulty": "Hard"
        },
        {
          "question_text": `Describe a time you solved a highly ambiguous technical bottleneck for the ${role} scope.`,
          "topic": "Behavioral",
          "difficulty": "Medium"
        }
      ];
    }
    return JSON.stringify({ "questions": qs });
  }

  if (promptLower.includes("evaluate the candidate's answer to the technical question")) {
    if (isAnsGibberish) {
      return JSON.stringify({
        "correctness_score": 0,
        "feedback": "The response contains unrecognizable characters or gibberish words. Technical score is graded as 0. Please explain the answer clearly."
      });
    }

    if (isAnsShortOrTrivial) {
      return JSON.stringify({
        "correctness_score": 5,
        "feedback": "The response is too brief or trivial. Please provide a complete technical explanation addressing the question."
      });
    }

    const qKws = new Set(extractKeywordsSimple(prompt));
    const aKws = new Set(extractKeywordsSimple(userAnswer));
    const sharedKws = [...qKws].filter(x => aKws.has(x));

    const genericTechVocab = new Set(["thread", "process", "memory", "event", "loop", "index", "b-tree", "hash", "cache", "latency", "scalable", "node", "cpu", "io", "reconciliation", "dom", "rendering", "ssr", "token", "security", "cors", "database", "query"]);
    const usedGeneric = [...genericTechVocab].some(t => userAnswer.toLowerCase().includes(t));

    const topicKeywords = {
      "system design": ["cache", "invalidation", "traffic", "database", "scale", "redis", "latency", "architecture", "load", "design"],
      "concurrency": ["process", "thread", "concurrency", "node", "single-threaded", "event", "loop", "concurrency"],
      "databases": ["index", "indexing", "b-tree", "hash", "scan", "database", "query", "sql"],
      "performance": ["react", "fiber", "reconciliation", "dom", "paint", "render", "virtual", "speed"],
      "architecture": ["csr", "ssr", "ssg", "render", "server", "client", "static", "architecture"],
      "security": ["cors", "csrf", "xss", "token", "security", "protect", "cookie", "auth"],
      "infrastructure": ["pipeline", "data", "monitor", "anomaly", "metric", "scale", "infrastructure"],
      "behavioral": ["star", "situation", "task", "action", "result", "solve", "ambiguous", "conflict"]
    };

    let topicClean = "";
    const topicMatch = prompt.match(/Topic:\s*([A-Za-z0-9\s\-]+?)\n/i);
    if (topicMatch) topicClean = topicMatch[1].trim().toLowerCase();

    let matchedTopicKws = [];
    for (const [t, kws] of Object.entries(topicKeywords)) {
      if (t.includes(topicClean) || topicClean.includes(t)) {
        matchedTopicKws = kws;
        break;
      }
    }

    const hasTopicMatch = matchedTopicKws.some(tk => userAnswer.toLowerCase().includes(tk));
    const hasTechnicalRelevance = sharedKws.length > 0 || hasTopicMatch || usedGeneric;

    let score = 50;
    let feedback = "The response is in valid English, but does not address the core technical concepts of the question (e.g. key mechanism details). Please provide an explanation addressing the specific concepts asked.";

    if (!hasTechnicalRelevance) {
      score = 5;
      feedback = "The answer does not address the technical question and lacks relevant concepts. Technical topics (such as database indexes, event loops, or security protocols) were missed. Please provide a response focused on the technical requirements of the question.";
    } else {
      if (sharedKws.length > 0 || hasTopicMatch) {
        score = 65;
        feedback = "Answer was too brief. Please provide a more detailed architectural explanation containing concrete examples.";
        if (userAnswer.length > 50) {
          score = 85;
          feedback = `Solid response. You correctly identified key factors and trade-offs. To improve, discuss testing methodologies under mock conditions at ${company}.`;
        }
        if (userAnswer.length > 150) {
          score = 95;
          feedback = `Outstanding, comprehensive response. Excellent depth showing strong design patterns and familiarity with runtime execution issues.`;
        }
      } else {
        if (userAnswer.length > 80) {
          score = 30;
          feedback = "The answer is detailed but lacks technical relevance to the question prompt. Technical topics (such as database indexes, event loops, or security protocols) were missed. Ensure you explain the specific technical topics requested.";
        }
      }
    }

    return JSON.stringify({
      "correctness_score": score,
      "feedback": feedback
    });
  }

  if (promptLower.includes("purely on communication quality")) {
    if (isAnsGibberish) {
      return JSON.stringify({
        "clarity": 0,
        "structure": 0,
        "confidence": 0,
        "conciseness": 0,
        "overall": 0,
        "one_line_feedback": "The response contains unrecognizable characters or gibberish. Communication score is graded as 0."
      });
    }

    if (isAnsShortOrTrivial) {
      return JSON.stringify({
        "clarity": 10,
        "structure": 10,
        "confidence": 10,
        "conciseness": 10,
        "overall": 10,
        "one_line_feedback": "The response is too brief or trivial to evaluate communication quality. Please provide a complete response."
      });
    }

    const text = userAnswer.toLowerCase();
    const fillers = ["like", "um", "ah", "eh", "actually", "basically", "so yeah"];
    let fillerCount = 0;
    for (const f of fillers) {
      const regex = new RegExp(f, 'g');
      fillerCount += (text.match(regex) || []).length;
    }

    const clarity = 90 - Math.min(fillerCount * 5, 20);
    let structure = 85;
    if (text.includes("star") || text.includes("situation") || text.includes("result")) {
      structure = 95;
    }

    let conciseness = 95;
    if (userAnswer.length > 300) {
      conciseness = 70;
    } else if (userAnswer.length < 30) {
      conciseness = 50;
    }

    let confidence = 90 - Math.min(fillerCount * 4, 25);
    if (userAnswer.length < 20) {
      confidence = 60;
    }

    const overall = Math.floor((clarity + structure + conciseness + confidence) / 4);

    const feedbackLines = [];
    if (fillerCount > 2) {
      feedbackLines.push(`Try to minimize filler words like 'like' or 'um' (detected ${fillerCount} pauses).`);
    }
    if (userAnswer.length < 50) {
      feedbackLines.push("Expand on your answers to show structural detail.");
    } else if (userAnswer.length > 300) {
      feedbackLines.push("Try to summarize details to avoid rambling.");
    }
    if (feedbackLines.length === 0) {
      feedbackLines.push("Excellent pacing, structure, and articulate vocabulary.");
    }

    return JSON.stringify({
      "clarity": clarity,
      "structure": structure,
      "confidence": confidence,
      "conciseness": conciseness,
      "overall": overall,
      "one_line_feedback": feedbackLines.join(" ")
    });
  }

  if (promptLower.includes("produce a prioritized list") || promptLower.includes("final report synthesizer") || promptLower.includes("expert technical interviewer") || promptLower.includes("resume fit critique") || promptLower.includes("resume section feedback")) {
    return JSON.stringify({
      "resume_summary": `The candidate's resume sections demonstrate solid foundations in core software engineering concepts, showing robust domain familiarity in areas like API routing, caching, and state management. However, for a ${role} position at ${company}, the current descriptions lack sufficient business-impact quantification and scale details, which are key filters used by recruiters to evaluate engineering seniority. \n\nTo raise the alignment for ${company}'s hiring bar, the candidate needs to explicitly document high-throughput configurations, concurrency limits, and database query optimization metrics in sections like Projects and Experience, showing they have designed services capable of running under heavy load.`,
      
      "technical_summary": `Technical responses demonstrate strong basic familiarity with developer frameworks and server setups, with correct identification of database scaling bottlenecks and cache eviction choices. However, when probed on system-design trade-offs or complex runtime concurrency limits, the explanations tended to be high-level and generic rather than concrete. \n\nTo align with ${company}'s technical standards for the ${role} role, the candidate must focus on deep dive explanations, discussing specific query plan analyses (e.g. index scans vs. seq scans), caching strategies (write-behind vs. write-through), and browser rendering optimizations (such as reconciliation triggers or virtual DOM cycles).`,
      
      "action_plan": [
        {
          "recommendation": `Quantify engineering contributions on your resume to match ${company}'s scale standards. In your Projects and Experience sections, rewrite key achievements using the STAR methodology to explicitly state the starting metrics (e.g., query response latencies), the specific optimization actions taken (such as implementing distributed caching or indexing tables), and the final percentage improvements. Showing concrete metrics like a '40% reduction in query latency' or 'handling 10,000 concurrent sessions' is essential for ${company}'s SDE evaluations.`,
          "priority": "High"
        },
        {
          "recommendation": `Deepen your technical explanations of database design and memory caching strategies. For ${company}'s technical SDE round, you need to transition from high-level descriptions (e.g. 'using Redis') to detailed system-level parameters. Practice explaining the trade-offs of cache eviction algorithms (such as LRU vs LFU) and database indexing architectures (such as B-Trees vs Hash indexes), demonstrating a granular understanding of how database pages are read and cached in production.`,
          "priority": "Medium"
        },
        {
          "recommendation": `Eliminate speech pauses and structure behavioral responses using the STAR method. During your communication assessments, a high rate of filler phrases ('um', 'like', 'basically') was detected, which impacts perceived technical confidence. Record your voice answers to behavioral questions, ensuring you cleanly demarcate the Situation, Task, Action, and Result, while keeping your pacing steady to align with standard executive panel evaluations.`,
          "priority": "Low"
        }
      ]
    });
  }
  if (promptLower.includes("ats score") || promptLower.includes("applicant tracking system")) {
    return JSON.stringify({
      "ats_score": 75,
      "matching_keywords": ["JavaScript", "React.js", "Python", "SQL", "Git", "REST APIs", "TypeScript"],
      "missing_keywords": ["Docker", "AWS (EC2/RDS)", "CI/CD Pipelines", "System Design", "Observability (Grafana)", "Unit Testing (Jest)"],
      "feedback": [
        `Align your resume bullet points for the ${role} position at ${company} by explicitly adding scale metrics (e.g. latency percentiles, requests per second).`,
        `Include infrastructure keywords such as Docker and AWS which are standard requirements for ${company}'s hiring standard.`,
        "Reorganize your Technical Skills section into categories like Languages, Frameworks, and Cloud Tools for better machine parsing layout."
      ]
    });
  }

  return JSON.stringify({ "status": "ok" });
}

async function callGroq(prompt, apiKey, forceJson = false) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  const payload = {
    "model": "llama-3.1-8b-instant",
    "messages": [
      { "role": "user", "content": prompt }
    ],
    "temperature": 0.2
  };

  if (forceJson) {
    payload["response_format"] = { "type": "json_object" };
  }

  try {
    console.log("Calling Groq API...");
    const response = await axios.post(url, payload, { headers, timeout: 15000 });
    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("Groq API Error:", err.message);
    const defaultKey = process.env.GROQ_API_KEY || "";
    if (apiKey !== defaultKey && defaultKey) {
      console.log("Falling back to default Groq API key...");
      try {
        const fallbackHeaders = { ...headers, "Authorization": `Bearer ${defaultKey}` };
        const response = await axios.post(url, payload, { headers: fallbackHeaders, timeout: 15000 });
        return response.data.choices[0].message.content;
      } catch (fallbackErr) {
        console.error("Fallback Groq API Error:", fallbackErr.message);
      }
    }
    console.warn("Falling back to simulation mode as a last resort.");
    return generateDynamicSimulation(prompt);
  }
}

async function callGemini(prompt, apiKey, forceJson = false) {
  console.log("Routing request through Groq API engine...");
  const actualKey = (apiKey && apiKey.trim().startsWith("gsk_"))
    ? apiKey.trim()
    : (process.env.GROQ_API_KEY || "");

  return callGroq(prompt, actualKey, forceJson);
}

function parseJsonSafely(text) {
  let clean = text.trim();
  if (clean.startsWith("```json")) {
    clean = clean.slice(7).trim();
  }
  if (clean.endsWith("```")) {
    clean = clean.slice(0, -3).trim();
  }
  try {
    return JSON.parse(clean);
  } catch (err) {
    const match = clean.match(/(\{.*\}|\[.*\])/s);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {}
    }
    throw new Error("Failed to parse JSON from LLM: " + text);
  }
}

module.exports = {
  isGibberish,
  isShortOrTrivial,
  extractSkills,
  segmentResumeRegex,
  callGemini,
  generateDynamicSimulation,
  generateImprovedVersion,
  parseJsonSafely
};
