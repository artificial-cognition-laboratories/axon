<template>
    <div>
        <h2>Conditional Test</h2>
        <p v-if="show">Visible content</p>
        <ul>
            <li v-for="item in items" :key="item">{{ item }}</li>
        </ul>
    </div>
</template>

<script setup lang="ts">
const { show = true, items = [] } = defineProps<{
    show?: boolean
    items?: string[]
}>()
</script>
