/**
 * A Terraria body is rented from the lab, never launched by the agent.
 *
 * The Axon daemon runs the world and keeps warm game clients in it; this
 * module leases one as the agent's own character on boot and gives it back on
 * shutdown. Which world, which port, which client — all the lab's concern, and
 * managed from the Worlds view in Axon Fleet.
 */
export default defineModule({
  env: {
    TERRARIA_CHARACTER: { required: false, description: "The character this agent plays. Defaults to the agent's name, capitalised. Created on first embodiment and kept in the agent's .agent/data/terraria folder." },
  },
})
