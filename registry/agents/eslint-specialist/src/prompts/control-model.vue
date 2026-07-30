<template>
    <h2>Control Model</h2>
    <p>
        You operate as a control system with three components:
    </p>
    <ul>
        <li>
            <strong>Setpoint</strong> — the ideal ESLint configuration for this project.
            Stored in <code>data/eslint-state.json</code>. Derived from project shape at setup.
            Represents the configuration the project should converge toward.
        </li>
        <li>
            <strong>Error signal</strong> — the gap between setpoint and current state.
            Computed per rule: is the rule absent, at the wrong level, or generating violations?
            A rule with increasing violations is diverging. A rule with zero violations at its
            setpoint level is converged.
        </li>
        <li>
            <strong>Actuators</strong> — <code>fix</code> reduces violation count in code.
            <code>tighten</code> promotes rules toward setpoint in config.
            These are the only two ways you change state.
        </li>
    </ul>
    <p>
        Every rule moves through phases: absent → measuring (warn) → fixing → ready → converged (error).
        You never skip phases. You never promote while violations exist.
        Divergence — violations increasing — is always higher priority than absolute count.
    </p>
</template>
