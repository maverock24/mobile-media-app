# Answers: Fullstack Development with LLMs & Agents

*Note: Generating a full 60-page document (6 pages per question) in a single response exceeds the technical output limits of the model. Below are condensed, high-density answers outlining the core strategies for each topic. We can expand any specific question into a longer essay upon request.*

## 1. Context & Workspace Management

### Context Optimization
The most efficient way to package context is through **hierarchical condensation**. Instead of feeding raw code, use tools that generate an Abstract Syntax Tree (AST) or a "repomap" (like Aider uses) that outlines the structure without the implementation details. Only provide full file contents for the specific files being modified. Combine this with specialized MCP (Model Context Protocol) servers that allow the LLM to query only what it needs, keeping the context window uncluttered and focused.

### Memory & Preferences
Establish a robust memory system using **workspace instruction files** (such as `.claude/CLAUDE.md`, `.cursorrules`, or custom agent `.instructions.md`). These files should explicitly state your tech stack (SvelteKit, Vite, Capacitor), testing runners, and formatting preferences. For long-term memory, utilize built-in persistent memory tools that allow agents to write notes to a `/memories/` directory.

## 2. Code Generation & Refactoring

### Vertical Slicing
To prompt for a vertical slice successfully, enforce a **contract-first methodology**. Prompt the agent to first define the database schema and API contract (types). Once you approve the contract, instruct the agent to generate the backend logic, followed by the frontend component. Giving the agent a structured step-by-step framework within a single prompt prevents it from hallucinating missing endpoints while building the UI.

### Legacy Code & Refactoring
The safest workflow is **Characterization Test-Driven Refactoring**. First, direct the agent to write extensive characterization tests treating the old monolith as a black box. Once tests pass against the legacy code, instruct the agent to refactor the internal logic into decoupled components. If a test fails, the agent autonomously reverts or fixes the new implementation. 

### Library Updates
Guarantee the use of the latest frameworks by strictly mandating the use of **Retrieval-Augmented Generation (RAG) and MCP tools** (like Context7). Instruct your agent: "Before writing SvelteKit code, use the Context7 MCP to fetch the latest documentation for Svelte 5." This forces the agent to context-switch out of its outdated pre-trained weights and rely purely on the injected, up-to-date documentation.

## 3. Debugging & Testing

### Agentic TDD
Yes, Agentic TDD is highly effective. You define the feature requirements as a prompt. The agent's first step is to write a comprehensive test suite. Then, utilizing an automated loop (e.g., via bash execution tools), the agent runs the test framework. It reads the test failures, writes the implementation, and iteratively loops until the terminal reports full passing tests, requiring zero human intervention.

### Deep Debugging
For cross-stack bugs, direct the agent to use a **"breadcrumb" strategy**. Instead of guessing the bug from static code, instruct the agent to insert extensive console logs and telemetry at the UI boundary, API gateway, and database layer. Run the app, reproduce the bug, and feed the combined logs back to the agent. The concrete execution trace eliminates the need to hold the entire complex state in the context window.

## 4. Architecture & System Design

### Architectural Sounding Board
Use **Role-Playing and Constraint matrices**. Prompt the LLM using a framework: "Act as a Principal Solutions Architect. Evaluate REST vs. GraphQL for this project. Constraints: 10k DAU, mobile-first low bandwidth, small team. Provide a scored matrix on latency, dev velocity, and cacheability." Providing explicit constraints prevents generic advice and forces deep, contextual reasoning.

### Security Audits
Create a **systematic workflow for vulnerability scanning**. Prompt the agent to explicitly adopt an "OWASP top 10 auditor" persona. Instruct it to analyze the exact paths where user data enters the system (API endpoints, form inputs) and trace it to the database, specifically looking for injection flaws, CSRF, and broken access controls.

## 5. Automation & CI/CD

### CI/CD Integration
AI agents can be integrated into GitHub Actions via specialized docker containers or scripts (like PR-Agent or coding sub-agents). Configure your workflow so that on opening a PR, the agent automatically reads the diff, cross-references it with your style guide, leaves inline comments for optimizations, and auto-generates a summary, reducing reviewer load.

### Scripting & Task Delegation
Ideal tasks for delegation include: **Scaffolding and Boilerplate** (e.g., initial Docker files, Vite configs), **Data Mocking** (writing scripts to seed local databases with realistic fake data), and **E2E test writing** (giving the agent Playwright and telling it to write tests covering simple happy-path user flows). These are repetitive, high-context but low-complexity tasks perfect for agents.