//! Steps shared by this project's sequences. Each helper is held to the restrict profile
//! (`#[fprime(restrict)]`), the same rules as the sequences that call it.

use crate::*;

/// The receiver's operations, for `do_math_and_settle(1.5, MathOp::ADD, 2.0)`.
pub use crate::Dict::MathProject::MathOp;

/// How long to wait after a DO_MATH before the next step, in microseconds.
pub const SETTLE_US: u64 = 1_000_000;

/// Set the receiver's FACTOR parameter (the multiplier in the math operation).
#[fprime(restrict)]
pub fn set_factor(value: f32) {
    MathProject.mathReceiver.FACTOR_PRM_SET(value);
}

/// Request one math operation, then wait `SETTLE_US`.
#[fprime(restrict)]
pub fn do_math_and_settle(val1: f32, op: MathOp, val2: f32) {
    MathProject.mathSender.DO_MATH(val1, op, val2);
    rsleep(SETTLE_US);
}

/// Report the receiver's operation count as an event.
#[fprime(restrict)]
pub fn report_operation_count() {
    let ops = Tlm::MathProject.mathReceiver.NUMBER_OF_OPS().0;
    messagef!(ActivityHigh, "math operations so far: {}", ops);
}
