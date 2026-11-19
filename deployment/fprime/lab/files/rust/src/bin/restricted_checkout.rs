#![no_std]
#![no_main]

use rust::*;

/// Command-path checkout, written as a list of steps: the restrict profile allows commands,
/// telemetry and parameters, `let`/`const`, arithmetic and `if`.
#[fprime_main(restrict)]
pub fn main() {
    CdhCore.cmdDisp.CMD_NO_OP();
    CdhCore.cmdDisp.CMD_NO_OP_STRING("lab checkout");
    rsleep(1_000_000);
    CdhCore.cmdDisp.CMD_TEST_CMD_1(7, 2.5, 1);
}
