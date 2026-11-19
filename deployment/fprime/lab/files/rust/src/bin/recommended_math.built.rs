#![no_std]
#![no_main]

use rust::*;

/// One math operation with the receiver's FACTOR at 1.0. The recommended profile also allows
/// `if` on telemetry and parameters, and `messagef!` events; it rejects loops, `match`, helper
/// functions and calls other than set_fail_mode/rsleep/asleep/message/exit.
#[fprime_main(recommended)]
pub fn main() {
    let factor = Prm::MathProject.mathReceiver.FACTOR();
    if factor != 1.0 {
        message(EventSeverity::WarningLow, "FACTOR is not 1.0: setting it before DO_MATH");
        MathProject.mathReceiver.FACTOR_PRM_SET(1.0);
    }
    MathProject.mathSender.DO_MATH(6.0, MUL, 7.0);
    rsleep(2_000_000);
}
