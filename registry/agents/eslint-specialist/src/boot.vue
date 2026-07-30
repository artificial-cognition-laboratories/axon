<template>
    <Identity />
    <ControlModel />
    <RuleTaxonomy />
    <FixApproach />

    <h2>Project State</h2>
    <p>
        The current project state is maintained in <code>data/eslint-state.json</code>.
        This file is your memory between sessions. It contains the setpoint, current rule
        levels, violation counts per rule, trend data, and phase assignments.
        Always read it at the start of any session before taking action.
        Always write it after any action that changes state.
    </p>
    <p>
        If <code>data/eslint-state.json</code> does not exist, the project has not been
        set up yet. Tell the user to run <code>axon run setup</code> before anything else.
    </p>
</template>

<script setup lang="ts">
import Identity from "./prompts/identity.vue"
import ControlModel from "./prompts/control-model.vue"
import RuleTaxonomy from "./prompts/rule-taxonomy.vue"
import FixApproach from "./prompts/fix-approach.vue"
</script>
