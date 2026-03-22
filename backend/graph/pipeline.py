"""LangGraph pipeline — Full: Planner → SQL → [Viz, Stats] → Critic → Report."""

from langgraph.graph import StateGraph, END
from backend.graph.state import AgentState
from backend.agents.planner import planner_agent
from backend.agents.sql_agent import sql_agent
from backend.agents.viz_agent import viz_agent
from backend.agents.stats_agent import stats_agent
from backend.agents.critic_agent import critic_agent
from backend.agents.report_agent import report_agent


def route_after_planner(state: AgentState) -> str:
    """Planner → SQL Agent or END (direct answer)."""
    plan = state.get("plan", [])
    if not plan:
        return END
    if "sql" in plan:
        return "sql_agent"
    return END


def route_after_sql(state: AgentState) -> str:
    """SQL → Viz (if planned and data available) or next stage."""
    plan = state.get("plan", [])
    sql_result = state.get("sql_result", {})

    if sql_result.get("error") or not sql_result.get("final_rows"):
        return "report"  # Skip Viz/Stats/Critic, go straight to Report for error handling

    if "viz" in plan:
        return "viz_agent"
    if "stats" in plan:
        return "stats_agent"
    return "critic"


def route_after_viz(state: AgentState) -> str:
    """Viz → Stats (if planned) or Critic."""
    plan = state.get("plan", [])
    if "stats" in plan:
        return "stats_agent"
    return "critic"


def route_after_critic(state: AgentState) -> str:
    """Critic → Report (pass) or retry target (retry)."""
    verdict = state.get("critic_verdict", "pass")
    if verdict == "pass":
        return "report"

    target = state.get("retry_target", "sql")
    target_map = {"sql": "sql_agent", "viz": "viz_agent", "stats": "stats_agent"}
    return target_map.get(target, "report")


def build_pipeline():
    """Build the full analysis pipeline graph."""

    graph = StateGraph(AgentState)

    # Nodes
    graph.add_node("planner", planner_agent)
    graph.add_node("sql_agent", sql_agent)
    graph.add_node("viz_agent", viz_agent)
    graph.add_node("stats_agent", stats_agent)
    graph.add_node("critic", critic_agent)
    graph.add_node("report", report_agent)

    # Entry
    graph.set_entry_point("planner")

    # Planner → conditional
    graph.add_conditional_edges("planner", route_after_planner)

    # SQL → conditional (Viz / Stats / Critic / Report)
    graph.add_conditional_edges("sql_agent", route_after_sql)

    # Viz → conditional (Stats / Critic)
    graph.add_conditional_edges("viz_agent", route_after_viz)

    # Stats → Critic
    graph.add_edge("stats_agent", "critic")

    # Critic → conditional (Report / retry)
    graph.add_conditional_edges("critic", route_after_critic)

    # Report → END
    graph.add_edge("report", END)

    return graph.compile()


pipeline = build_pipeline()