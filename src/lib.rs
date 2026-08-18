mod utils;

use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

type WaterCellLocation = (u32, u32, u32);

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,
    cells: Vec<i32>,
    water_cell_locations: Vec<WaterCellLocation>,
    max_height: i32,
    min_height: i32,
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
            water_cell_locations: vec![],
            min_height,
            max_height,
        }
    }

    pub fn handle_user_input(&mut self, row: f64, col: f64) {
        self.water_cell_locations.push((row as u32, col as u32, 0))
    }

    pub fn tick(&mut self) {
        let current_water_cell_locations = self.water_cell_locations.clone();
        let mut next_water_cell_locations = Vec::new();

        for &(row, col, age) in &current_water_cell_locations {
            if age > 50 {
                continue;
            }
            match self.calculate_flow_direction(row, col) {
                Some(dir) => {
                    let (new_row, new_col) = self.next_position(row, col, dir);
                    next_water_cell_locations.push((new_row, new_col, age + 1));
                }
                // No downhill neighbour: water sits still and ages out.
                None => next_water_cell_locations.push((row, col, age + 1)),
            }
        }
        self.water_cell_locations = next_water_cell_locations;
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
        self.water_cell_locations
            .iter()
            .flat_map(|&(row, col, _age)| [row, col])
            .collect()
    }
    pub fn water_cells_count(&self) -> usize {
        self.water_cell_locations.len()
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
}
