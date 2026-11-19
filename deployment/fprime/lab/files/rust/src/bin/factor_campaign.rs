#![no_std]
#![no_main]

use rust::*;

/// Set FACTOR, run two operations and report the operation count, using the project's helpers
/// (src/helpers.rs). Restrict allows calling them; they are checked against restrict too.
#[fprime_main(restrict)]
pub fn main() {
    set_fail_mode(FailMode::Checked);
    helpers::set_factor(2.0);
    helpers::do_math_and_settle(1.5, helpers::MathOp::ADD, 2.0);
    helpers::do_math_and_settle(10.0, helpers::MathOp::DIV, 4.0);
    helpers::report_operation_count();
}
