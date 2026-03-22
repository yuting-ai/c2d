"""LangGraph pipeline — Phase 3: Planner → SQL Agent → Report Agent."""

from langgraph.graph import StateGraph, END
from backend.graph.state import AgentState
from backend.agents.planner import planner_agent
from backend.agents.sql_agent import sql_agent
from backend.agents.report_agent import report_agent


def route_after_planner(state: AgentState) -> str:
    """Route based on planner decision: activate SQL or skip to END."""
    plan = state.get("plan", [])
    if not plan:
        # Direct answer — planner already populated sql_result.answer
        return END
    if "sql" in plan:
        return "sql_agent"
    return END


def build_pipeline():
    """Build the analysis pipeline graph."""

    graph = StateGraph(AgentState)

    # Nodes
    graph.add_node("planner", planner_agent)
    graph.add_node("sql_agent", sql_agent)
    graph.add_node("report", report_agent)

    # Entry
    graph.set_entry_point("planner")

    # Planner → conditional: SQL Agent or END (direct answer)
    graph.add_conditional_edges("planner", route_after_planner)

    # SQL Agent → Report Agent
    graph.add_edge("sql_agent", "report")

    # Report Agent → END
    graph.add_edge("report", END)

    return graph.compile()


# Singleton pipeline instance
pipeline = build_pipeline()