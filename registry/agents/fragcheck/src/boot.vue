<template>
    <Identity />
    <SystemSpecs />
    <Method />
    <Checklist />
    <ReportFormat />
</template>

<script setup lang="ts">
import Identity from "./prompts/components/identity.vue"
import SystemSpecs from "./prompts/components/system-specs.vue"
import Method from "./prompts/components/method.vue"
import Checklist from "./prompts/components/checklist.vue"
import ReportFormat from "./prompts/components/report-format.vue"
</script>