import { ComponentFixture, TestBed } from '@angular/core/testing';
import { JoistPanel } from './joist-panel';

describe('JoistPanel', () => {
  let component: JoistPanel;
  let fixture: ComponentFixture<JoistPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [JoistPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(JoistPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
