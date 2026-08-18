mod utils;

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Water a droplet carries when it lands. With the default absorption of 1.0 a
/// droplet lasts 50 ticks, which is exactly the flat lifetime this replaced —
/// so a grid with no soil data behaves as it always did.
const DEFAULT_DROPLET_WATER: f32 = 50.0;

/// Absorption used where the soil survey has no reading. Deliberately the value
/// that reproduces the old behaviour: gaps are common (open water, most of a
/// dense city) and inventing a soil type for them would put made-up physics
/// exactly where this is most often pointed.
const DEFAULT_ABSORPTION: f32 = 1.0;

/// Backstop lifetime. Absorption drains a droplet on its own, but a cell with a
/// near-zero rate would otherwise keep one alive forever and the population
/// would grow without bound.
const MAX_AGE: u32 = 400;

struct Droplet {
    row: u32,
    col: u32,
    age: u32,
    /// Remaining water. The ground takes its absorption rate out of this each
    /// tick, and the droplet is gone when nothing is left.
    water: f32,
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,
    cells: Vec<i32>,
    droplets: Vec<Droplet>,
    max_height: i32,
    min_height: i32,
    /// Infiltration capacity per cell. Empty means no soil data was supplied,
    /// in which case every cell uses `DEFAULT_ABSORPTION`. A negative entry
    /// means the survey had no reading for that one cell, and is treated the
    /// same way.
    absorption: Vec<f32>,
    droplet_water: f32,
}

#[wasm_bindgen]
impl Universe {
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<i32>, width: u32, height: u32) -> Universe {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        assert_eq!(
            data.len(),
            (width as usize) * (height as usize),
            "data length must equal width * height"
        );
        let max_height = *data.iter().max().expect("empty elevation data");
        let min_height = *data.iter().min().expect("empty elevation data");
        Universe {
            width,
            height,
            cells: data,
            droplets: vec![],
            min_height,
            max_height,
            absorption: vec![],
            droplet_water: DEFAULT_DROPLET_WATER,
        }
    }

    pub fn handle_user_input(&mut self, row: f64, col: f64) {
        self.droplets.push(Droplet {
            row: row as u32,
            col: col as u32,
            age: 0,
            water: self.droplet_water,
        })
    }

    /// Supply infiltration capacity per cell, in whatever units pair with
    /// `droplet_water`. Negative entries mark cells the soil survey does not
    /// cover.
    pub fn set_absorption(&mut self, rates: Vec<f32>) {
        assert_eq!(
            rates.len(),
            (self.width as usize) * (self.height as usize),
            "absorption length must equal width * height"
        );
        self.absorption = rates;
    }

    /// Drop back to a single flat lifetime everywhere, so the two can be compared.
    pub fn clear_absorption(&mut self) {
        self.absorption.clear();
    }

    /// How much water a droplet lands with. The one knob pairing droplet counts
    /// to absorption rates.
    pub fn set_droplet_water(&mut self, water: f32) {
        self.droplet_water = water;
    }

    fn absorption_at(&self, row: u32, col: u32) -> f32 {
        if self.absorption.is_empty() {
            return DEFAULT_ABSORPTION;
        }
        let rate = self.absorption[(row * self.width + col) as usize];
        if rate > 0.0 {
            rate
        } else {
            DEFAULT_ABSORPTION
        }
    }

    pub fn tick(&mut self) {
        let mut next = Vec::with_capacity(self.droplets.len());

        for i in 0..self.droplets.len() {
            let (row, col, age, water) = {
                let d = &self.droplets[i];
                (d.row, d.col, d.age, d.water)
            };

            // The ground under the droplet takes its share first, so a droplet
            // over free-draining soil covers less distance before it is gone.
            let water = water - self.absorption_at(row, col);
            if water <= 0.0 || age >= MAX_AGE {
                continue;
            }

            let (row, col) = match self.calculate_flow_direction(row, col) {
                Some(dir) => self.next_position(row, col, dir),
                // No downhill neighbour: water sits still and soaks in where it is.
                None => (row, col),
            };
            next.push(Droplet { row, col, age: age + 1, water });
        }
        self.droplets = next;
    }

    /// Steepest-descent neighbour, or `None` if every neighbour is at least as high.
    fn calculate_flow_direction(&self, row: u32, column: u32) -> Option<&'static str> {
        let current = self
            .get_cell_value(row as i32, column as i32)
            .expect("water cell outside the grid");
        let r = row as i32;
        let c = column as i32;
        let mut scores = HashMap::new();
        for (name, dr, dc) in [
            ("w", 0, -1),
            ("nw", -1, -1),
            ("n", -1, 0),
            ("ne", -1, 1),
            ("e", 0, 1),
            ("se", 1, 1),
            ("s", 1, 0),
            ("sw", 1, -1),
        ] {
            if let Some(h) = self.get_cell_value(r + dr, c + dc) {
                scores.insert(name, current - h);
            }
        }
        let (dir, drop) = scores.iter().max_by_key(|entry| entry.1)?;
        if *drop <= 0 {
            return None;
        }
        Some(dir)
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Flat `[row, col, row, col, ...]` of the live water cells.
    /// A copy per frame rather than a pointer into wasm memory: there are only
    /// ever a handful of water cells, and it keeps JS out of the heap.
    pub fn water_cells(&self) -> Vec<u32> {
        self.droplets
            .iter()
            .flat_map(|d| [d.row, d.col])
            .collect()
    }
    pub fn water_cells_count(&self) -> usize {
        self.droplets.len()
    }
    pub fn min_height(&self) -> i32 {
        self.min_height
    }
    pub fn max_height(&self) -> i32 {
        self.max_height
    }
    pub fn get_cell_value(&self, row: i32, column: i32) -> Option<i32> {
        if row >= 0 && column >= 0 && row < self.height as i32 && column < self.width as i32 {
            Some(self.cells[(row as u32 * self.width + column as u32) as usize])
        } else {
            None
        }
    }

    fn next_position(&self, row: u32, column: u32, direction: &str) -> (u32, u32) {
        match direction {
            "w" => (row, column - 1),
            "nw" => (row - 1, column - 1),
            "n" => (row - 1, column),
            "ne" => (row - 1, column + 1),
            "e" => (row, column + 1),
            "se" => (row + 1, column + 1),
            "s" => (row + 1, column),
            "sw" => (row + 1, column - 1),
            other => unreachable!("unknown flow direction {}", other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3x3 bowl: everything drains to the centre.
    #[test]
    fn water_flows_downhill_and_settles() {
        let data = vec![9, 8, 9, 8, 0, 8, 9, 8, 9];
        let mut u = Universe::new(data, 3, 3);
        assert_eq!((u.min_height(), u.max_height()), (0, 9));

        u.handle_user_input(0.0, 0.0);
        u.tick(); // (0,0) -> steepest drop is se to the 0
        assert_eq!(u.water_cells(), vec![1, 1]);

        u.tick(); // sits in the sink
        assert_eq!(u.water_cells(), vec![1, 1]);
    }

    #[test]
    fn water_ages_out() {
        let mut u = Universe::new(vec![0; 9], 3, 3);
        u.handle_user_input(1.0, 1.0);
        for _ in 0..52 {
            u.tick();
        }
        assert_eq!(u.water_cells_count(), 0);
    }

    /// How long one droplet survives on flat ground.
    fn lifetime(absorption: Option<Vec<f32>>) -> u32 {
        let mut u = Universe::new(vec![0; 9], 3, 3);
        if let Some(rates) = absorption {
            u.set_absorption(rates);
        }
        u.handle_user_input(1.0, 1.0);
        let mut ticks = 0;
        while u.water_cells_count() > 0 && ticks < 1000 {
            u.tick();
            ticks += 1;
        }
        ticks
    }

    #[test]
    fn free_draining_soil_kills_a_droplet_sooner() {
        let sand = lifetime(Some(vec![10.0; 9])); // hydrologic group A
        let clay = lifetime(Some(vec![1.0; 9])); //  hydrologic group D
        assert!(
            sand < clay,
            "sand should drain faster: sand {} ticks vs clay {}",
            sand,
            clay
        );
        // The rates differ by 10x, so the lifetimes should too.
        assert_eq!(sand, 5);
        assert_eq!(clay, 50);
    }

    #[test]
    fn no_soil_data_behaves_as_before() {
        // Both the absent grid and a cell the survey does not cover fall back to
        // the lifetime this replaced, so a gap changes nothing.
        assert_eq!(lifetime(None), 50);
        assert_eq!(lifetime(Some(vec![-1.0; 9])), 50);
    }

    #[test]
    fn droplet_water_scales_lifetime() {
        let mut u = Universe::new(vec![0; 9], 3, 3);
        u.set_absorption(vec![2.0; 9]);
        u.set_droplet_water(100.0);
        u.handle_user_input(1.0, 1.0);
        let mut ticks = 0;
        while u.water_cells_count() > 0 && ticks < 1000 {
            u.tick();
            ticks += 1;
        }
        assert_eq!(ticks, 50, "100 units of water at 2 per tick");
    }

    #[test]
    fn absorption_is_taken_from_the_cell_the_droplet_is_on() {
        // A bowl draining to the centre, where the centre soaks water up fast and
        // the rim does not. A droplet must die quickly once it reaches the sink,
        // which only holds if the rate is read at the droplet's own position.
        let mut u = Universe::new(vec![9, 8, 9, 8, 0, 8, 9, 8, 9], 3, 3);
        let mut rates = vec![1.0; 9];
        rates[4] = 25.0; // the sink
        u.set_absorption(rates);
        u.handle_user_input(0.0, 0.0);
        let mut ticks = 0;
        while u.water_cells_count() > 0 && ticks < 1000 {
            u.tick();
            ticks += 1;
        }
        // One tick on the rim at 1.0, then the sink at 25.0 drains the remaining 49.
        assert_eq!(ticks, 3);
    }

    #[test]
    fn a_droplet_cannot_outlive_the_backstop() {
        // Absorption of zero is treated as no reading, so this still terminates;
        // the backstop is what guarantees it for any rate.
        let mut u = Universe::new(vec![0; 9], 3, 3);
        u.set_absorption(vec![0.0; 9]);
        u.set_droplet_water(f32::MAX);
        u.handle_user_input(1.0, 1.0);
        let mut ticks = 0;
        while u.water_cells_count() > 0 && ticks < 1000 {
            u.tick();
            ticks += 1;
        }
        assert!(ticks <= MAX_AGE + 1, "bounded by the backstop, got {}", ticks);
    }
}
