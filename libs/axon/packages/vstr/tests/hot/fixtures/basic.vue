<template>
    <div>
        <h1>Hello {{ name }}</h1>
        <p>This is a basic test.</p>
    </div>
</template>

<script setup lang="ts">
const { name = "world" } = defineProps<{ name?: string }>()
</script>
