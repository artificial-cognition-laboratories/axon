<template>
    <div>
        <h2>Async Result</h2>
        <p>{{ data }}</p>
        <p>{{ computed }}</p>
    </div>
</template>

<script setup lang="ts">
// fetchData and transform are injected via context
const data = await fetchData()
const computed = transform(data)
</script>
