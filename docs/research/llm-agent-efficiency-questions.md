# Efficiency Questions: Fullstack Development with LLMs & Agents

## 1. Context & Workspace Management
*   **Context Optimization:** What is the most efficient way to package and pass my entire fullstack project's context (frontend structure, database schemas, API routes, and custom design guidelines like shadcn/ui) to an LLM without hitting context window limits or confusing the model?
*   **Memory & Preferences:** How can I establish a robust "memory" system for my agents so they instinctively know my preferred tech stack (e.g., SvelteKit, Vite, Capacitor, Tailwind) and architectural patterns without me repeating them every session?

## 2. Code Generation & Refactoring
*   **Vertical Slicing:** How can I prompt an agent to consistently generate a complete "vertical slice" of a feature—such as the database migration, backend endpoint, frontend component, and API integration—in a single, cohesive workflow?
*   **Legacy Code & Refactoring:** What is the safest and fastest agentic workflow to refactor bulky, legacy monolith code into modern, decoupled components while guaranteeing no regressions?
*   **Library Updates:** How can I best utilize Retrieval-Augmented Generation (RAG) or MCP tools (like Context7) to guarantee the LLM writes code using the absolute latest documentation of fast-moving frameworks, avoiding deprecated API hallucinations?

## 3. Debugging & Testing
*   **Agentic TDD:** Can I fully delegate Test-Driven Development (TDD) to an autonomous agent where I simply define the feature requirements, and the agent iterates between writing tests and implementing the code until tests pass?
*   **Deep Debugging:** When facing a complex bug that spans the frontend state (e.g., Svelte stores) and the database edge, how can I direct an agent to trace the execution path and identify the root cause faster than traditional step-through debugging?

## 4. Architecture & System Design
*   **Architectural Sounding Board:** How can I optimally use advanced reasoning models to debate architectural trade-offs (e.g., choosing between REST vs. GraphQL, or Serverless vs. Long-running containers) based on my specific user load and latency requirements?
*   **Security Audits:** What is the workflow for having an autonomous agent proactively scan my fullstack codebase for OWASP vulnerabilities or insecure data handling practices as I write code?

## 5. Automation & CI/CD
*   **CI/CD Integration:** How can I integrate AI agents directly into my GitHub pipelines to automatically review Pull Requests, suggest micro-optimizations, or even auto-fix lint/type errors before I merge?
*   **Scripting & Task Delegation:** Which repetitive daily developer tasks (like writing boilerplate boilerplate, scaffolding out CI configs, or creating mock data scripts) are ripe to be handed over entirely to a background agent?