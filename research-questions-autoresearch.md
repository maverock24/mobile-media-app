# Research Questions: Agentic Self-Improvement & Automated Research

## Agentic Self-Improvement
1. **Alignment Drift:** How can we formally guarantee or mathematically bound alignment retention when an autonomous agent is iteratively modifying its own cognitive architecture, learning algorithms, or reward functions?
2. **Synthetic Data Ceilings:** What are the theoretical limits of self-improvement relying entirely on self-generated synthetic data, and at what point does model collapse or lack of external grounding halt progress?
3. **Reward Hacking in Self-Correction:** When agents autonomously design their own curricula and intermediate evaluation metrics for self-improvement, how do we systematically detect and prevent highly obfuscated reward hacking?
4. **Exploration vs. Exploitation in Meta-Learning:** How can self-improving agents optimally balance exploiting their current capabilities to solve tasks efficiently versus exploring radically new internal representations that might temporarily degrade performance but yield higher theoretical ceilings?

## Automated Research (e.g. Karpathy's Autoresearch Paradigm)
5. **Novelty Evaluation:** How can an automated Open-Source AI Scientist or auto-researcher accurately evaluate the semantic novelty and scientific value of a generated hypothesis against the massive, unstructured corpus of existing literature?
6. **Execution and Debugging in the Loop:** What mechanisms are required for an LLM-based agent to reliably execute, verify, and iteratively debug long-horizon experimental ML code (like complex multi-GPU training loops) without any human-in-the-loop intervention?
7. **Automated Peer Review:** Can we develop a robust, unbiased meta-evaluation framework to assess the critical peer-review capabilities of an AI evaluating another AI's generated research methodologies and papers?
8. **Methodological Self-Correction:** To what extent can an autoresearch system autonomously identify, explain, and correct systemic methodological flaws (e.g., data leakage, improper baselines) in its own novel experimental designs?
9. **Resource Allocation:** How should an autonomous research agent optimally allocate constrained compute resources among literature review, hypothesis generation, empirical experimentation, and paper drafting to maximize the impact of its output?