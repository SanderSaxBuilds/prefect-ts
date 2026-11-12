"""Flow served by the integration suite.

The suite runs `python flows.py` with PREFECT_API_URL pointing at a local
`prefect server start`. `greet.serve()` registers the deployment
"greet/ts-integration" and executes every run the TypeScript client creates.
"""

import time

from prefect import flow, get_run_logger, task


@task
def say(name: str, index: int) -> str:
    get_run_logger().info("Hello, %s (%d)", name, index)
    return f"{name}-{index}"


@flow
def greet(name: str = "world", count: int = 2, fail: bool = False, sleep: float = 0) -> list[str]:
    logger = get_run_logger()
    results = [say(name, index) for index in range(count)]
    if sleep:
        logger.info("sleeping for %s seconds", sleep)
        time.sleep(sleep)
    if fail:
        raise ValueError(f"asked to fail for {name}")
    logger.info("done with %d greetings", len(results))
    return results


if __name__ == "__main__":
    greet.serve(
        name="ts-integration",
        tags=["ts-integration"],
        parameters={"name": "world", "count": 2},
        limit=4,
    )
