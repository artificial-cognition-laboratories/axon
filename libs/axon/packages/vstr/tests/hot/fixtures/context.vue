<template>
    <div>
        <h2>Context Test</h2>
        <p>{{ greeting }}</p>
        <p>Tool result: {{ toolResult }}</p>
    </div>
</template>

<script setup lang="ts">
// myApi and myTool are injected via context — not imported, not props
const greeting = myApi.hello("world")
const toolResult = await myTool()
</script>
