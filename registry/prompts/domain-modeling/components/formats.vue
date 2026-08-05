<template>
    <section>
        <h2>Formats</h2>

        <h3>CONTEXT.md — the glossary</h3>

        <p>
            One entry per term: the term, one or two sentences defining what it
            <em>is</em> (not what it does), and the words it displaces.
        </p>

        <pre>{{ contextExample }}</pre>

        <ul>
            <li><strong>Be opinionated.</strong> Where several words exist for one concept, pick the best and list the rest under <em>Avoid</em>.</li>
            <li><strong>Keep definitions tight.</strong> One or two sentences.</li>
            <li><strong>Only terms specific to this project.</strong> General programming concepts — timeouts, error types, utility patterns — do not belong, however much the project uses them. Ask: is this unique to this domain, or is it just programming?</li>
            <li><strong>Group under subheadings</strong> when natural clusters emerge; a flat list is fine otherwise.</li>
        </ul>

        <p>
            A repo with several distinct domains puts a map at the root naming
            each context and where it lives, with one glossary per context
            rather than one shared list.
        </p>

        <h3>ADR — a recorded decision</h3>

        <p>
            One file per decision, numbered and named, stating the context that
            forced the choice, the decision itself, the alternatives that were
            genuinely considered, and the consequences accepted.
        </p>

        <pre>{{ adrExample }}</pre>

        <p>
            Write the alternatives honestly. An ADR listing only the option
            that won is a press release; the value is entirely in what was
            rejected and why.
        </p>
    </section>
</template>

<script setup lang="ts">
const contextExample = `# Ordering

How customers place and track orders.

## Language

**Order**:
A confirmed request for goods at an agreed price.
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organisation that places orders.
_Avoid_: Client, buyer, account`

const adrExample = `# 0002 — Postgres for the write model

## Status
Accepted

## Context
What made this a decision rather than a default — the constraint,
the pressure, the thing that would break under the obvious choice.

## Decision
What was chosen, stated plainly.

## Alternatives
What else was genuinely considered, and why each lost.

## Consequences
What this costs, and what becomes harder later.`
</script>
